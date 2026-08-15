export type RuntimeKind = "model-tool-loop" | "openai-agents" | "claude-code";
export interface BotDefinition {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  enabled: boolean;
  runtime: RuntimeKind;
  modelPolicyId?: string;
  systemPrompt?: string;
  purpose?: "general" | "system-assistant";
  effectMode?: "standard" | "read-only";
  capabilityPolicy?: "resolved" | "none";
  maxConcurrentExecutions: number;
  autonomousReplyBeta: boolean;
  historyBackfillBeta: boolean;
  maxBackfillMessages: number;
  createdAt: string;
  updatedAt: string;
}
export interface Execution {
  id: string;
  tenantId: string;
  botId: string;
  runtime: RuntimeKind;
  prompt: string;
  systemPrompt?: string;
  conversationId?: string;
  conversationKey?: string;
  workspaceId: string;
  sessionId: string;
  modelPolicyId?: string;
  effectMode?: "standard" | "read-only";
  capabilityPolicy?: "resolved" | "none";
  source: Record<string, unknown>;
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "cancelled";
  cancelRequested?: boolean;
  approvalId?: string;
  response?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface RuntimeSession {
  id: string;
  tenantId: string;
  botId: string;
  conversationKey: string;
  workspaceId: string;
  modelSessionId: string;
  messages: Array<{ role: "user" | "assistant"; content: string; at: string }>;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}
export interface RuntimeEvent {
  id: string;
  executionId: string;
  sequence: number;
  type:
    | "started"
    | "context"
    | "capabilities"
    | "progress"
    | "tool_call"
    | "tool_result"
    | "session"
    | "result"
    | "delivery"
    | "error"
    | "cancelled";
  data: Record<string, unknown>;
  createdAt: string;
}
export interface RuntimeInput {
  tenantId: string;
  botId: string;
  runtime?: RuntimeKind;
  prompt: string;
  systemPrompt?: string;
  conversationId?: string;
  sessionId?: string;
  modelPolicyId?: string;
  source?: Record<string, unknown>;
  contextQuery?: string;
}
