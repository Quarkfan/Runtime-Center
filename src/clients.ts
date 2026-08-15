export interface PlatformClients {
  policy(input: unknown, signal?: AbortSignal): Promise<any>;
  approval(input: unknown, signal?: AbortSignal): Promise<any>;
  approvalStatus(id: string, signal?: AbortSignal): Promise<any>;
  context(input: unknown, signal?: AbortSignal): Promise<any>;
  transcript(input: unknown, signal?: AbortSignal): Promise<any>;
  capabilities(input: unknown, signal?: AbortSignal): Promise<any>;
  command(input: unknown, signal?: AbortSignal): Promise<any>;
  workflow(input: unknown, signal?: AbortSignal): Promise<any>;
  continuation(input: unknown, signal?: AbortSignal): Promise<any>;
  invokeCapability(input: unknown, signal?: AbortSignal): Promise<any>;
  model(input: unknown, signal?: AbortSignal): Promise<any>;
  delivery(input: unknown, signal?: AbortSignal): Promise<any>;
}
export class HttpPlatformClients implements PlatformClients {
  constructor(
    readonly urls: {
      governance: string;
      context: string;
      capabilities: string;
      model: string;
      message: string;
      scheduler: string;
    },
    readonly token: string,
  ) {}
  private async post(
    url: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ) {
    const r = await fetch(`${url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(300000)])
          : AbortSignal.timeout(300000),
      }),
      text = await r.text();
    const parsed = JSON.parse(text);
    if (!r.ok) {
      const error = Object.assign(
        new Error(
          parsed?.error?.message ??
            `${path} failed (${r.status}): ${text.slice(0, 1000)}`,
        ),
        {
          statusCode: r.status,
          code: parsed?.error?.code,
          details: parsed?.error?.details,
        },
      );
      throw error;
    }
    return parsed.data;
  }
  private async get(url: string, path: string, signal?: AbortSignal) {
    const r = await fetch(`${url}${path}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(300000)])
          : AbortSignal.timeout(300000),
      }),
      text = await r.text(),
      parsed = JSON.parse(text);
    if (!r.ok)
      throw Object.assign(
        new Error(parsed?.error?.message ?? `${path} failed (${r.status})`),
        {
          statusCode: r.status,
          code: parsed?.error?.code,
          details: parsed?.error?.details,
        },
      );
    return parsed.data;
  }
  policy(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.governance, "/v1/policy/check", i, signal);
  }
  approval(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.governance, "/v1/approvals", i, signal);
  }
  approvalStatus(id: string, signal?: AbortSignal) {
    return this.get(
      this.urls.governance,
      `/v1/approvals/${encodeURIComponent(id)}`,
      signal,
    );
  }
  context(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.context, "/v1/retrieve", i, signal);
  }
  transcript(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.context, "/v1/transcripts", i, signal);
  }
  capabilities(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.capabilities, "/v1/resolve", i, signal);
  }
  command(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.capabilities, "/v1/commands/resolve", i, signal);
  }
  workflow(i: unknown, signal?: AbortSignal) {
    return this.post(
      this.urls.capabilities,
      "/v1/workflows/resolve",
      i,
      signal,
    );
  }
  continuation(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.scheduler, "/v1/continuations", i, signal);
  }
  invokeCapability(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.capabilities, "/v1/invoke", i, signal);
  }
  model(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.model, "/v1/invoke", i, signal);
  }
  delivery(i: unknown, signal?: AbortSignal) {
    return this.post(this.urls.message, "/v1/deliveries", i, signal);
  }
}
