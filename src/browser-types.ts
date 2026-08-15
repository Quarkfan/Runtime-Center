export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; selector: string; sensitive?: boolean }
  | { type: "fill"; selector: string; value: string; sensitive?: boolean }
  | { type: "select"; selector: string; value: string }
  | { type: "check"; selector: string; checked: boolean }
  | { type: "press"; selector: string; key: string }
  | { type: "hover"; selector: string }
  | { type: "wait"; selector?: string; milliseconds?: number }
  | { type: "inspect" }
  | { type: "extract"; selector: string }
  | { type: "download"; selector: string; name?: string }
  | { type: "pdf"; name?: string; format?: "A4" | "Letter" }
  | { type: "screenshot"; name?: string; fullPage?: boolean };
export interface BrowserWorkflowRequest {
  tenantId: string;
  botId: string;
  sessionKey: string;
  startUrl?: string;
  allowedDomains: string[];
  actions: BrowserAction[];
  keepAlive: boolean;
  recordVideo?: boolean;
  approvalId?: string;
  correlationId: string;
}
export interface BrowserStep {
  index: number;
  action: BrowserAction["type"];
  status: "succeeded" | "failed" | "waiting_approval";
  url?: string;
  title?: string;
  output?: unknown;
  artifactId?: string;
  error?: string;
  at: string;
}

export interface BrowserAgentRequest {
  tenantId: string;
  botId: string;
  goal: string;
  sessionKey: string;
  startUrl?: string;
  allowedDomains: string[];
  modelPolicyId?: string;
  authenticationFlow?:
    | "external-wait"
    | "credential-login"
    | "captcha-assisted"
    | "otp-assisted"
    | "manual-input"
    | "none"
    | "custom";
  maxSteps: number;
  keepAlive: boolean;
  recordVideo?: boolean;
  approvalId?: string;
  correlationId: string;
}
