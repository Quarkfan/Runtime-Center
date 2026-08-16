import type { PlatformClients } from "./clients.js";
import type { Execution, RuntimeEvent } from "./types.js";

export class CapabilityFacade {
  private readonly available = new Map<string, any>();
  constructor(
    readonly clients: PlatformClients,
    readonly execution: Execution,
    capabilities: any[],
    readonly emit: (
      type: RuntimeEvent["type"],
      data: Record<string, unknown>,
    ) => Promise<void>,
  ) {
    for (const capability of capabilities)
      this.available.set(String(capability.manifest.id), capability);
  }

  async invoke(input: {
    capabilityId: string;
    value: Record<string, unknown>;
    toolCallId: string;
    runtime: string;
    signal: AbortSignal;
  }) {
    const capability = this.available.get(input.capabilityId);
    if (!capability)
      throw new Error(
        `Capability is not part of the admitted snapshot: ${input.capabilityId}`,
      );
    await this.emit("tool_call", {
      toolCallId: input.toolCallId,
      capabilityId: input.capabilityId,
      input: input.value,
      runtime: input.runtime,
      bindingId: capability.binding?.id,
      packageId: capability.manifest.packageId,
    });
    try {
      const invoked = await this.clients.invokeCapability(
        {
          tenantId: this.execution.tenantId,
          botId: this.execution.botId,
          capabilityId: input.capabilityId,
          input: input.value,
          trigger:
            this.execution.source.type === "scheduled" ||
            this.execution.source.type === "continuation"
              ? "scheduled"
              : "agent",
          correlationId: `${this.execution.id}:${input.toolCallId}`,
          approvalId: this.execution.approvalId,
        },
        input.signal,
      );
      await this.emit("tool_result", {
        toolCallId: input.toolCallId,
        capabilityId: input.capabilityId,
        status: "succeeded",
        output: invoked.output,
        runtime: input.runtime,
      });
      return invoked.output;
    } catch (error) {
      await this.emit("tool_result", {
        toolCallId: input.toolCallId,
        capabilityId: input.capabilityId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        runtime: input.runtime,
      });
      throw error;
    }
  }
}
