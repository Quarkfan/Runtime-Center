export type LegacyRuntimeKind =
  "model-tool-loop" | "openai-agents" | "claude-code";
export type RuntimeKind = string;
export type ProviderLifecycleState =
  | "installed"
  | "verified"
  | "canary"
  | "active"
  | "draining"
  | "disabled"
  | "failed"
  | "retired";
export type ProviderProbeStatus =
  "ready" | "degraded" | "unavailable" | "incompatible";
export interface RuntimeProviderDescriptor {
  providerId: string;
  family: "runtime";
  version: string;
  contractVersion: string;
  displayName: string;
  description?: string;
  isolation: "in-process" | "worker" | "process" | "container" | "remote";
  capabilities: Record<string, boolean | string | number>;
  configurationSchema: Record<string, unknown>;
  credentialKinds: string[];
  compatibility: {
    platformApi: string;
    operatingSystems?: string[];
    architectures?: string[];
  };
}
export interface RuntimeProviderProbe {
  status: ProviderProbeStatus;
  observedCapabilities: Record<string, boolean | string | number>;
  checkedAt: string;
  latencyMs?: number;
  reason?: string;
}
export interface RuntimeProviderRecord {
  descriptor: RuntimeProviderDescriptor;
  lifecycleState: ProviderLifecycleState;
  builtIn: boolean;
  generation: number;
  lastProbe?: RuntimeProviderProbe;
  lastError?: string;
  installedAt: string;
  updatedAt: string;
}
export interface RuntimeProfile {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  revision: number;
  enabled: boolean;
  runtimeProviderId: string;
  modelPolicyId?: string;
  contextPolicyId?: string;
  capabilityBindingSetId?: string;
  governancePolicyId?: string;
  workspacePolicyId?: string;
  promptSectionRefs: string[];
  limits: Record<string, boolean | string | number>;
  fallbackProviderIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface RuntimeProfileSnapshot {
  snapshotId: string;
  profileId: string;
  profileRevision: number;
  resolvedAt: string;
  provider: RuntimeProviderDescriptor;
  modelPolicyId?: string;
  contextPolicyId?: string;
  capabilityBindingSetId?: string;
  governancePolicyId?: string;
  workspacePolicyId?: string;
  promptSectionRefs: string[];
  limits: Record<string, boolean | string | number>;
  fallbackProviderIds: string[];
  compatibility: boolean;
}
export interface BotDefinition {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  enabled: boolean;
  runtime: RuntimeKind;
  runtimeProfileId?: string;
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
  runtimeProviderId?: string;
  runtimeSessionId?: string;
  runtimeProfileSnapshot?: RuntimeProfileSnapshot;
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
export interface SessionLedgerEvent {
  id: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  schemaVersion: "1.0";
  executionId: string;
  tenantId: string;
  botId: string;
  correlationId: string;
  idempotencyKey: string;
  producer: { center: "runtime-center"; version: string };
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface RuntimeInput {
  tenantId: string;
  botId: string;
  runtime?: RuntimeKind;
  runtimeProviderId?: string;
  runtimeProfileId?: string;
  prompt: string;
  systemPrompt?: string;
  conversationId?: string;
  sessionId?: string;
  modelPolicyId?: string;
  source?: Record<string, unknown>;
  contextQuery?: string;
}
