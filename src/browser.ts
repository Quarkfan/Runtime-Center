import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type {
  BrowserAction,
  BrowserAgentRequest,
  BrowserStep,
  BrowserWorkflowRequest,
} from "./browser-types.js";
export interface BrowserPageObservation {
  url: string;
  title: string;
  text: string;
  elements: Array<{
    selector: string;
    tag: string;
    role?: string;
    type?: string;
    name: string;
    value?: string;
  }>;
}
export interface BrowserHandle {
  url(): string;
  title(): Promise<string>;
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  check(selector: string, checked: boolean): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  hover(selector: string): Promise<void>;
  wait(selector?: string, milliseconds?: number): Promise<void>;
  inspect(): Promise<BrowserPageObservation>;
  extract(selector: string): Promise<string>;
  download(selector: string, path: string): Promise<string>;
  pdf(path: string, format: "A4" | "Letter"): Promise<void>;
  screenshot(path: string, fullPage: boolean): Promise<void>;
  close(tracePath?: string): Promise<{ videoPaths: string[] }>;
}
export interface BrowserEngine {
  open(
    directory: string,
    options?: { recordVideo?: boolean },
  ): Promise<BrowserHandle>;
}
class PlaywrightHandle implements BrowserHandle {
  constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly statePath: string,
    readonly stateKey: Buffer,
  ) {}
  url() {
    return this.page.url();
  }
  title() {
    return this.page.title();
  }
  async navigate(url: string) {
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }
  async click(s: string) {
    await this.page.locator(s).click({ timeout: 30000 });
  }
  async fill(s: string, v: string) {
    await this.page.locator(s).fill(v, { timeout: 30000 });
  }
  async select(s: string, v: string) {
    await this.page.locator(s).selectOption(v, { timeout: 30000 });
  }
  async check(s: string, v: boolean) {
    const x = this.page.locator(s);
    if (v) await x.check({ timeout: 30000 });
    else await x.uncheck({ timeout: 30000 });
  }
  async press(s: string, k: string) {
    await this.page.locator(s).press(k, { timeout: 30000 });
  }
  async hover(s: string) {
    await this.page.locator(s).hover({ timeout: 30000 });
  }
  async wait(s?: string, ms?: number) {
    if (s) await this.page.locator(s).waitFor({ timeout: 30000 });
    else await this.page.waitForTimeout(Math.min(ms ?? 1000, 30000));
  }
  async inspect(): Promise<BrowserPageObservation> {
    const text = (await this.page.locator("body").innerText({ timeout: 30000 }))
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, 30000);
    const elements = await this.page
      .locator(
        'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
      )
      .evaluateAll((nodes) =>
        nodes.slice(0, 120).flatMap((node, index) => {
          const element = node as HTMLElement;
          const style = getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            element.getBoundingClientRect().width === 0
          )
            return [];
          const selector = `qft-${index}`;
          element.setAttribute("data-qft-ref", selector);
          const input = element as HTMLInputElement;
          return [
            {
              selector: `[data-qft-ref="${selector}"]`,
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role") ?? undefined,
              type: input.type || undefined,
              name: (
                element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                input.placeholder ||
                element.innerText ||
                input.name ||
                input.id ||
                ""
              )
                .trim()
                .slice(0, 240),
              value:
                input.type === "password"
                  ? undefined
                  : String(input.value ?? "").slice(0, 500) || undefined,
            },
          ];
        }),
      );
    return {
      url: this.page.url(),
      title: await this.page.title(),
      text,
      elements,
    };
  }
  extract(s: string) {
    return this.page.locator(s).innerText({ timeout: 30000 });
  }
  async download(selector: string, path: string) {
    const [download] = await Promise.all([
      this.page.waitForEvent("download", { timeout: 60000 }),
      this.page.locator(selector).click({ timeout: 30000 }),
    ]);
    await download.saveAs(path);
    return download.suggestedFilename();
  }
  async pdf(path: string, format: "A4" | "Letter") {
    await this.page.pdf({ path, format, printBackground: true });
  }
  async screenshot(path: string, fullPage: boolean) {
    await this.page.screenshot({ path, fullPage });
  }
  async close(tracePath?: string) {
    if (tracePath) await this.context.tracing.stop({ path: tracePath });
    const state = await this.context.storageState();
    await writeEncryptedJson(this.statePath, state, this.stateKey);
    const videos = this.context
      .pages()
      .map((page) => page.video())
      .filter(Boolean);
    await this.context.close();
    await this.browser.close();
    const videoPaths: string[] = [];
    for (const video of videos) {
      try {
        videoPaths.push(await video!.path());
      } catch {
        // A page without recording has no video artifact.
      }
    }
    return { videoPaths };
  }
}
export class PlaywrightEngine implements BrowserEngine {
  constructor(
    readonly stateKey: Buffer,
    readonly allowPrivateNetworks = false,
  ) {
    if (stateKey.length !== 32)
      throw new Error("Browser state key must be exactly 32 bytes");
  }
  async migrateRoot(root: string) {
    await mkdir(root, { recursive: true });
    const directories = (await readdir(root, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory(),
    );
    for (const entry of directories) {
      const directory = join(root, entry.name),
        names = new Set(await readdir(directory).catch(() => []));
      if (names.has("Default")) await this.migrateLegacyProfile(directory);
      else await removeUnencryptedSessionFiles(directory);
    }
  }
  private async migrateLegacyProfile(directory: string) {
    await Promise.all(
      ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) =>
        rm(join(directory, name), { recursive: true, force: true }),
      ),
    );
    const context = await chromium.launchPersistentContext(directory, {
      executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
      headless: true,
    });
    try {
      await writeEncryptedJson(
        join(directory, "storage-state.enc"),
        await context.storageState(),
        this.stateKey,
      );
    } finally {
      await context.close();
    }
    await removeUnencryptedSessionFiles(directory);
  }
  async open(directory: string, options: { recordVideo?: boolean } = {}) {
    await mkdir(directory, { recursive: true });
    const statePath = join(directory, "storage-state.enc"),
      storageState = await readEncryptedJson(statePath, this.stateKey),
      browser = await chromium.launch({
        executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
        headless: true,
      }),
      context = await browser.newContext({
        acceptDownloads: true,
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
        ...(storageState ? { storageState } : {}),
        ...(options.recordVideo
          ? {
              recordVideo: {
                dir: join(directory, "videos"),
                size: { width: 1280, height: 720 },
              },
            }
          : {}),
      });
    if (!this.allowPrivateNetworks)
      await context.route("**/*", async (route) => {
        try {
          if (await isSafeBrowserRequest(route.request().url()))
            await route.continue();
          else await route.abort("blockedbyclient");
        } catch {
          await route.abort("blockedbyclient");
        }
      });
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    return new PlaywrightHandle(
      browser,
      context,
      context.pages()[0] ?? (await context.newPage()),
      statePath,
      this.stateKey,
    );
  }
}

async function writeEncryptedJson(path: string, value: unknown, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv),
    ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(value))),
      cipher.final(),
    ]),
    payload = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
    temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, payload, { mode: 0o600 });
  await rename(temporary, path);
}

async function readEncryptedJson(path: string, key: Buffer) {
  try {
    const payload = JSON.parse(await readFile(path, "utf8")),
      decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64"),
      );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Encrypted browser state is invalid or unreadable");
  }
}

async function removeUnencryptedSessionFiles(directory: string) {
  const entries = await readdir(directory).catch(() => []);
  await Promise.all(
    entries
      .filter(
        (name) =>
          name !== "storage-state.enc" &&
          !/^checkpoint-[a-f0-9]+\.json$/.test(name),
      )
      .map((name) =>
        rm(join(directory, name), { recursive: true, force: true }),
      ),
  );
}
export interface BrowserDependencies {
  policy(input: unknown): Promise<any>;
  requestApproval(input: unknown): Promise<any>;
  approval(id: string): Promise<any | undefined>;
  artifact(input: {
    tenantId: string;
    botId: string;
    name: string;
    mediaType: string;
    data: Buffer;
  }): Promise<{ id: string }>;
  model(input: {
    policyId?: string;
    kind: "chat";
    messages: Array<{ role: "system" | "user"; content: string }>;
    responseFormat: Record<string, unknown>;
    correlationId: string;
  }): Promise<unknown>;
}
const now = () => new Date().toISOString();
const isSensitive = (a: BrowserAction, targetHint = "") =>
  ("sensitive" in a && a.sensitive) ||
  a.type === "download" ||
  (a.type === "click" &&
    /submit|save|delete|remove|pay|purchase|publish|send|confirm|提交|保存|删除|支付|发布|发送|确认/i.test(
      `${a.selector} ${targetHint}`,
    )) ||
  (a.type === "fill" &&
    /password|secret|token|密码|密钥/i.test(`${a.selector} ${targetHint}`));
export class BrowserWorkerService {
  private sessions = new Map<
    string,
    {
      handle: BrowserHandle;
      tenantId: string;
      botId: string;
      sessionKey: string;
      recordVideo: boolean;
      lastUsedAt: number;
    }
  >();
  constructor(
    readonly engine: BrowserEngine,
    readonly deps: BrowserDependencies,
    readonly root: string,
    readonly sessionTtlMs = 30 * 60 * 1000,
    readonly allowPrivateNetworks = false,
  ) {}
  key(v: BrowserWorkflowRequest) {
    return createHash("sha256")
      .update(`${v.tenantId}:\0${v.botId}:\0${v.sessionKey}`)
      .digest("hex");
  }
  allowed(url: string, domains: string[]) {
    const p = new URL(url);
    const hostname = normalizedHostname(p.hostname);
    return (
      ["http:", "https:"].includes(p.protocol) &&
      (this.allowPrivateNetworks ||
        (!isPrivateAddress(hostname) && hostname !== "localhost")) &&
      domains.some((value) => {
        const domain = normalizedHostname(value);
        return hostname === domain || hostname.endsWith(`.${domain}`);
      })
    );
  }
  async run(v: BrowserWorkflowRequest) {
    await this.reapExpired();
    if (!v.allowedDomains.length) throw new Error("allowedDomains is required");
    if (v.actions.length > 50) throw new Error("Maximum 50 browser steps");
    const key = this.key(v),
      dir = join(this.root, key);
    let session = this.sessions.get(key);
    if (session && session.recordVideo !== Boolean(v.recordVideo))
      throw new Error(
        "An active browser session cannot change recordVideo mode; close it first",
      );
    if (!session) {
      session = {
        handle: await this.engine.open(dir, { recordVideo: v.recordVideo }),
        tenantId: v.tenantId,
        botId: v.botId,
        sessionKey: v.sessionKey,
        recordVideo: Boolean(v.recordVideo),
        lastUsedAt: Date.now(),
      };
      this.sessions.set(key, session);
    }
    session.lastUsedAt = Date.now();
    const handle = session.handle;
    const actions: BrowserAction[] = [
        ...(v.startUrl ? [{ type: "navigate" as const, url: v.startUrl }] : []),
        ...v.actions,
      ],
      steps: BrowserStep[] = [];
    const checkpointPath = join(
      dir,
      `checkpoint-${createHash("sha256").update(v.correlationId).digest("hex")}.json`,
    );
    let startIndex = 0;
    if (v.approvalId) {
      try {
        const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
        if (checkpoint.approvalId !== v.approvalId)
          throw new Error(
            "Approval does not match the saved browser checkpoint",
          );
        startIndex = Number(checkpoint.actionIndex);
        if (
          !Number.isInteger(startIndex) ||
          startIndex < 0 ||
          startIndex >= actions.length
        )
          throw new Error("Browser checkpoint is invalid");
      } catch (error) {
        if (error instanceof Error && error.message.includes("Approval"))
          throw error;
        throw new Error(
          "Browser approval checkpoint is unavailable or invalid",
        );
      }
    }
    for (let index = startIndex; index < actions.length; index++) {
      const action = actions[index]!;
      try {
        if (
          action.type === "navigate" &&
          !this.allowed(action.url, v.allowedDomains)
        )
          throw new Error("Navigation domain is not allowed");
        const targetHint =
          action.type === "click" || action.type === "fill"
            ? ((await handle.inspect()).elements.find(
                (element) => element.selector === action.selector,
              )?.name ?? "")
            : "";
        if (isSensitive(action, targetHint)) {
          const decision = await this.deps.policy({
              tenantId: v.tenantId,
              actor: { type: "bot", id: v.botId, roles: [] },
              action: `browser.${action.type}`,
              resource: { type: "browser-session", id: key },
              context: { botId: v.botId, risk: "high", interactive: true },
              correlationId: v.correlationId,
            }),
            approved = v.approvalId
              ? await this.deps.approval(v.approvalId)
              : undefined;
          if (v.approvalId && approved?.status !== "approved")
            throw new Error(
              `Browser approval is ${approved?.status ?? "unavailable"}`,
            );
          const approvalMatches =
            approved?.status === "approved" &&
            approved.tenantId === v.tenantId &&
            approved.requesterId === v.botId &&
            approved.action === `browser.${action.type}` &&
            approved.resource?.sessionKey === v.sessionKey &&
            Number(approved.resource?.step) === index &&
            approved.expiresAt > now();
          if (
            decision.obligations?.some((x: any) => x.type === "approval") &&
            !approvalMatches
          ) {
            const approval =
              approved ??
              (await this.deps.requestApproval({
                decisionId: decision.id,
                tenantId: v.tenantId,
                requesterId: v.botId,
                action: `browser.${action.type}`,
                resource: { sessionKey: v.sessionKey, step: index },
              }));
            await writeFile(
              checkpointPath,
              JSON.stringify({ approvalId: approval.id, actionIndex: index }),
              { mode: 0o600 },
            );
            steps.push({
              index,
              action: action.type,
              status: "waiting_approval",
              output: { approvalId: approval.id },
              at: now(),
            });
            return {
              status: "waiting_approval",
              sessionKey: v.sessionKey,
              steps,
            };
          }
        }
        let output: unknown, artifactId: string | undefined;
        if (action.type === "navigate") await handle.navigate(action.url);
        else if (action.type === "click") await handle.click(action.selector);
        else if (action.type === "fill")
          await handle.fill(action.selector, action.value);
        else if (action.type === "select")
          await handle.select(action.selector, action.value);
        else if (action.type === "check")
          await handle.check(action.selector, action.checked);
        else if (action.type === "press")
          await handle.press(action.selector, action.key);
        else if (action.type === "hover") await handle.hover(action.selector);
        else if (action.type === "wait")
          await handle.wait(action.selector, action.milliseconds);
        else if (action.type === "inspect") output = await handle.inspect();
        else if (action.type === "extract")
          output = await handle.extract(action.selector);
        else if (action.type === "download") {
          const path = join(dir, `download-${index}-${randomUUID()}`);
          const suggested = await handle.download(action.selector, path);
          const name = safeName(
            action.name ?? suggested ?? `download-${index}`,
          );
          const artifact = await this.deps.artifact({
            tenantId: v.tenantId,
            botId: v.botId,
            name,
            mediaType: mediaType(name),
            data: await readFile(path),
          });
          artifactId = artifact.id;
          output = { name };
          await rm(path, { force: true });
        } else if (action.type === "pdf") {
          const path = join(dir, `page-${index}-${randomUUID()}.pdf`),
            name = safeName(action.name ?? `browser-page-${index}.pdf`);
          await handle.pdf(path, action.format ?? "A4");
          const artifact = await this.deps.artifact({
            tenantId: v.tenantId,
            botId: v.botId,
            name,
            mediaType: "application/pdf",
            data: await readFile(path),
          });
          artifactId = artifact.id;
          await rm(path, { force: true });
        } else {
          const path = join(dir, `screenshot-${index}-${randomUUID()}.png`);
          await handle.screenshot(path, action.fullPage ?? true);
          const artifact = await this.deps.artifact({
            tenantId: v.tenantId,
            botId: v.botId,
            name: action.name ?? `browser-step-${index}.png`,
            mediaType: "image/png",
            data: await readFile(path),
          });
          artifactId = artifact.id;
          await rm(path, { force: true });
        }
        const current = handle.url();
        if (
          current &&
          current !== "about:blank" &&
          !this.allowed(current, v.allowedDomains)
        )
          throw new Error("Browser redirected outside allowed domains");
        steps.push({
          index,
          action: action.type,
          status: "succeeded",
          url: current,
          title: await handle.title(),
          output,
          artifactId,
          at: now(),
        });
        if (index === startIndex && v.approvalId)
          await rm(checkpointPath, { force: true });
      } catch (error) {
        steps.push({
          index,
          action: action.type,
          status: "failed",
          url: handle.url(),
          error: error instanceof Error ? error.message : "Browser step failed",
          at: now(),
        });
        const artifactIds = !v.keepAlive ? await this.close(key, v, true) : [];
        return {
          status: "failed",
          sessionKey: v.sessionKey,
          steps,
          artifactIds,
        };
      }
    }
    const artifactIds = !v.keepAlive ? await this.close(key, v, true) : [];
    return {
      status: "succeeded",
      sessionKey: v.sessionKey,
      steps,
      artifactIds,
    };
  }
  async runAgent(v: BrowserAgentRequest) {
    if (v.maxSteps < 1 || v.maxSteps > 30)
      throw new Error("Browser Agent maxSteps must be between 1 and 30");
    const history: Array<Record<string, unknown>> = [];
    const allSteps: BrowserStep[] = [];
    if (v.startUrl && !v.approvalId) {
      const opened = await this.run({
        ...v,
        actions: [],
        keepAlive: true,
      });
      allSteps.push(...opened.steps);
      if (opened.status !== "succeeded") return opened;
    }
    const pendingPath = join(
      this.root,
      this.key({ ...v, actions: [] }),
      `agent-${createHash("sha256").update(v.correlationId).digest("hex")}.json`,
    );
    if (v.approvalId) {
      let pending: { action?: BrowserAction };
      try {
        pending = JSON.parse(await readFile(pendingPath, "utf8"));
      } catch {
        throw new Error("Browser Agent approval checkpoint is unavailable");
      }
      if (!pending.action)
        throw new Error("Browser Agent approval checkpoint is invalid");
      const resumed = await this.run({
        ...v,
        startUrl: undefined,
        actions: [pending.action],
        keepAlive: true,
      });
      allSteps.push(...resumed.steps);
      if (resumed.status !== "succeeded") return resumed;
      await rm(pendingPath, { force: true });
    }
    for (let turn = 0; turn < v.maxSteps; turn++) {
      const observed = await this.run({
        ...v,
        startUrl: undefined,
        approvalId: undefined,
        actions: [{ type: "inspect" }],
        keepAlive: true,
        correlationId: `${v.correlationId}:observe:${turn}`,
      });
      allSteps.push(...observed.steps);
      if (observed.status !== "succeeded") return observed;
      const observation = observed.steps.at(-1)?.output;
      const planned = await this.deps.model({
        policyId: v.modelPolicyId,
        kind: "chat",
        messages: [
          {
            role: "system",
            content: browserAgentSystemPrompt(v.allowedDomains),
          },
          {
            role: "user",
            content: JSON.stringify({
              goal: v.goal,
              authenticationFlow: v.authenticationFlow ?? "none",
              observation,
              previousActions: history.slice(-12),
            }),
          },
        ],
        responseFormat: { type: "json_object" },
        correlationId: `${v.correlationId}:plan:${turn}`,
      });
      const decision = parseAgentDecision(planned);
      history.push(decision);
      if (decision.state === "done") {
        const artifactIds = v.keepAlive
          ? []
          : await this.close(
              this.key({ ...v, actions: [] }),
              { ...v, actions: [] },
              true,
            );
        return {
          status: "succeeded",
          sessionKey: v.sessionKey,
          answer: decision.answer,
          steps: allSteps,
          artifactIds,
        };
      }
      if (decision.state === "waiting_user") {
        const evidence = await this.run({
          ...v,
          startUrl: undefined,
          approvalId: undefined,
          actions: [{ type: "screenshot", name: "browser-authentication.png" }],
          keepAlive: true,
          correlationId: `${v.correlationId}:waiting-user`,
        });
        allSteps.push(...evidence.steps);
        return {
          status: "waiting_user",
          sessionKey: v.sessionKey,
          answer: decision.answer,
          steps: allSteps,
        };
      }
      const action = normalizeAgentAction(decision.action);
      const executed = await this.run({
        ...v,
        startUrl: undefined,
        approvalId: undefined,
        actions: [action],
        keepAlive: true,
        correlationId: v.correlationId,
      });
      allSteps.push(...executed.steps);
      if (executed.status === "waiting_approval") {
        await writeFile(pendingPath, JSON.stringify({ action }), {
          mode: 0o600,
        });
        return { ...executed, steps: allSteps };
      }
      if (executed.status !== "succeeded")
        return { ...executed, steps: allSteps };
    }
    return {
      status: "failed",
      sessionKey: v.sessionKey,
      steps: allSteps,
      error: `Browser Agent exceeded ${v.maxSteps} steps`,
    };
  }
  async close(key: string, v: BrowserWorkflowRequest, trace = false) {
    const session = this.sessions.get(key);
    if (!session) return [];
    const tracePath = trace
      ? join(this.root, key, `trace-${randomUUID()}.zip`)
      : undefined;
    const result = await session.handle.close(tracePath);
    this.sessions.delete(key);
    const artifactIds: string[] = [];
    if (tracePath) {
      const artifact = await this.deps.artifact({
        tenantId: v.tenantId,
        botId: v.botId,
        name: "browser-trace.zip",
        mediaType: "application/zip",
        data: await readFile(tracePath),
      });
      artifactIds.push(artifact.id);
      await rm(tracePath, { force: true });
    }
    for (const [index, videoPath] of result.videoPaths.entries()) {
      const artifact = await this.deps.artifact({
        tenantId: v.tenantId,
        botId: v.botId,
        name: `browser-recording-${index + 1}.webm`,
        mediaType: "video/webm",
        data: await readFile(videoPath),
      });
      artifactIds.push(artifact.id);
      await rm(videoPath, { force: true });
    }
    return artifactIds;
  }
  listSessions(filter: { tenantId?: string; botId?: string } = {}) {
    return [...this.sessions.entries()]
      .filter(
        ([, value]) =>
          (!filter.tenantId || value.tenantId === filter.tenantId) &&
          (!filter.botId || value.botId === filter.botId),
      )
      .map(([id, value]) => ({
        id,
        tenantId: value.tenantId,
        botId: value.botId,
        sessionKey: value.sessionKey,
        recordVideo: value.recordVideo,
        lastUsedAt: new Date(value.lastUsedAt).toISOString(),
      }));
  }
  async closeSession(tenantId: string, botId: string, sessionKey: string) {
    const request: BrowserWorkflowRequest = {
        tenantId,
        botId,
        sessionKey,
        allowedDomains: ["invalid.local"],
        actions: [],
        keepAlive: false,
        correlationId: randomUUID(),
      },
      key = this.key(request),
      artifactIds = await this.close(key, request, true);
    return {
      closed: artifactIds.length > 0 || !this.sessions.has(key),
      artifactIds,
    };
  }
  private async reapExpired() {
    const expired = [...this.sessions.entries()].filter(
      ([, value]) => Date.now() - value.lastUsedAt >= this.sessionTtlMs,
    );
    for (const [key, value] of expired) {
      await this.close(
        key,
        {
          tenantId: value.tenantId,
          botId: value.botId,
          sessionKey: value.sessionKey,
          allowedDomains: ["invalid.local"],
          actions: [],
          keepAlive: false,
          correlationId: randomUUID(),
        },
        true,
      );
    }
  }
}

const safeName = (value: string) =>
  value
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 200) || "browser-artifact";
const mediaType = (name: string) => {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return (
    {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      json: "application/json",
      csv: "text/csv",
      txt: "text/plain",
      zip: "application/zip",
    }[extension ?? ""] ?? "application/octet-stream"
  );
};

function browserAgentSystemPrompt(domains: string[]) {
  return `You are the planning component of a governed browser agent. Return one JSON object only. The allowed states are {"state":"act","action":BrowserAction,"reason":"..."}, {"state":"done","answer":"..."}, or {"state":"waiting_user","answer":"..."}. Use only selectors present in observation.elements. Supported actions are navigate, click, fill, select, check, press, hover, wait, extract, download, pdf, and screenshot. Navigation is restricted to: ${domains.join(", ")}. Mark click or fill actions as sensitive when they submit, save, delete, pay, purchase, publish, send, confirm, alter permissions or credentials, or create an irreversible side effect. Do not claim success until the page proves the goal. For QR, OAuth, SSO, captcha, OTP, or other external human interaction, return waiting_user at the page where the user can act. Never request shell execution or access local files.`;
}

function parseAgentDecision(value: unknown): Record<string, any> {
  const output =
    value && typeof value === "object" && "output" in value
      ? (value as Record<string, unknown>).output
      : value;
  let text =
    typeof output === "string"
      ? output
      : output &&
          typeof output === "object" &&
          typeof (output as Record<string, unknown>).text === "string"
        ? String((output as Record<string, unknown>).text)
        : JSON.stringify(output ?? {});
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1]!;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let decision: Record<string, any>;
  try {
    decision = JSON.parse(text);
  } catch {
    throw new Error("Browser Agent model returned invalid JSON");
  }
  if (!["act", "done", "waiting_user"].includes(decision.state))
    throw new Error("Browser Agent model returned an invalid state");
  if (decision.state === "act" && !decision.action)
    throw new Error("Browser Agent model omitted the next action");
  if (decision.state !== "act" && typeof decision.answer !== "string")
    throw new Error("Browser Agent model omitted its answer");
  return decision;
}

function normalizeAgentAction(value: unknown): BrowserAction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Browser Agent action is invalid");
  const action = value as Record<string, unknown>;
  const type = String(action.type ?? "");
  const string = (key: string, required = true) => {
    const result =
      typeof action[key] === "string" ? action[key].slice(0, 10000) : "";
    if (required && !result)
      throw new Error(`Browser Agent action requires ${key}`);
    return result;
  };
  if (type === "navigate") return { type, url: string("url") };
  if (type === "click")
    return {
      type,
      selector: string("selector"),
      sensitive: Boolean(action.sensitive),
    };
  if (type === "fill")
    return {
      type,
      selector: string("selector"),
      value: string("value", false),
      sensitive: Boolean(action.sensitive),
    };
  if (type === "select")
    return { type, selector: string("selector"), value: string("value") };
  if (type === "check")
    return {
      type,
      selector: string("selector"),
      checked: Boolean(action.checked),
    };
  if (type === "press")
    return { type, selector: string("selector"), key: string("key") };
  if (type === "hover") return { type, selector: string("selector") };
  if (type === "wait")
    return {
      type,
      selector: string("selector", false) || undefined,
      milliseconds: Math.min(
        30000,
        Math.max(0, Number(action.milliseconds ?? 1000)),
      ),
    };
  if (type === "extract") return { type, selector: string("selector") };
  if (type === "download")
    return {
      type,
      selector: string("selector"),
      name: string("name", false) || undefined,
    };
  if (type === "pdf")
    return {
      type,
      name: string("name", false) || undefined,
      format: action.format === "Letter" ? "Letter" : "A4",
    };
  if (type === "screenshot")
    return {
      type,
      name: string("name", false) || undefined,
      fullPage: action.fullPage !== false,
    };
  throw new Error(`Unsupported Browser Agent action: ${type}`);
}

function normalizedHostname(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isPrivateAddress(value: string): boolean {
  const host = normalizedHostname(value).split("%")[0]!;
  const version = isIP(host);
  if (version === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    if (host === "::" || host === "::1") return true;
    if (/^(?:fc|fd)/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return false;
}

async function isSafeBrowserRequest(value: string) {
  const url = new URL(value);
  if (["about:", "data:", "blob:"].includes(url.protocol)) return true;
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === "localhost" || isPrivateAddress(hostname))
    return false;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.length > 0 && addresses.every((x) => !isPrivateAddress(x.address));
}
