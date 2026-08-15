import type { BrowserDependencies } from "./browser.js";
export class HttpBrowserDependencies implements BrowserDependencies {
  constructor(
    readonly governance: string,
    readonly resource: string,
    readonly modelHub: string,
    readonly token: string,
  ) {}
  private async json(url: string, init?: RequestInit) {
    const r = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...init?.headers },
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
    return body.data;
  }
  policy(input: unknown) {
    return this.json(`${this.governance}/v1/policy/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  requestApproval(input: unknown) {
    return this.json(`${this.governance}/v1/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  async approval(id: string) {
    return this.json(
      `${this.governance}/v1/approvals/${encodeURIComponent(id)}`,
    );
  }
  async ready() {
    const checks = await Promise.allSettled([
      this.json(`${this.governance}/readyz`),
      this.json(`${this.resource}/readyz`),
      this.json(`${this.modelHub}/readyz`),
    ]);
    return checks.every((result) => result.status === "fulfilled");
  }
  async artifact(input: {
    tenantId: string;
    botId: string;
    name: string;
    mediaType: string;
    data: Buffer;
  }) {
    const form = new FormData();
    form.append("tenantId", input.tenantId);
    form.append("botId", input.botId);
    form.append("kind", "artifact");
    form.append(
      "file",
      new Blob([new Uint8Array(input.data)], { type: input.mediaType }),
      input.name,
    );
    const result = await this.json(`${this.resource}/v1/resources`, {
      method: "POST",
      body: form,
    });
    return { id: result.item.id as string };
  }
  model(input: {
    policyId?: string;
    kind: "chat";
    messages: Array<{ role: "system" | "user"; content: string }>;
    responseFormat: Record<string, unknown>;
    correlationId: string;
  }) {
    return this.json(`${this.modelHub}/v1/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }
}
