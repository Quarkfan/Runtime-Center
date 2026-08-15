import type {
  BotDefinition,
  Execution,
  RuntimeEvent,
  RuntimeSession,
} from "./types.js";
export interface RuntimeRepository {
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  saveBot(v: BotDefinition): Promise<BotDefinition>;
  bot(id: string): Promise<BotDefinition | undefined>;
  bots(tenantId?: string): Promise<BotDefinition[]>;
  removeBot(id: string): Promise<boolean>;
  saveExecution(v: Execution): Promise<Execution>;
  execution(id: string): Promise<Execution | undefined>;
  executions(tenantId?: string): Promise<Execution[]>;
  append(v: RuntimeEvent): Promise<void>;
  events(id: string): Promise<RuntimeEvent[]>;
  saveSession(v: RuntimeSession): Promise<RuntimeSession>;
  session(id: string): Promise<RuntimeSession | undefined>;
  sessionByConversation(
    tenantId: string,
    botId: string,
    conversationKey: string,
  ): Promise<RuntimeSession | undefined>;
  sessions(filter?: {
    tenantId?: string;
    botId?: string;
  }): Promise<RuntimeSession[]>;
  removeSession(id: string): Promise<boolean>;
}
export class MemoryRuntimeRepository implements RuntimeRepository {
  b = new Map<string, BotDefinition>();
  e = new Map<string, Execution>();
  v: RuntimeEvent[] = [];
  s = new Map<string, RuntimeSession>();
  async migrate() {}
  async ping() {
    return true;
  }
  async close() {}
  async saveBot(v: BotDefinition) {
    this.b.set(v.id, structuredClone(v));
    return v;
  }
  async bot(id: string) {
    return this.b.get(id);
  }
  async bots(t?: string) {
    return [...this.b.values()].filter((x) => !t || x.tenantId === t);
  }
  async removeBot(id: string) {
    return this.b.delete(id);
  }
  async saveExecution(v: Execution) {
    this.e.set(v.id, structuredClone(v));
    return v;
  }
  async execution(id: string) {
    return this.e.get(id);
  }
  async executions(t?: string) {
    return [...this.e.values()].filter((x) => !t || x.tenantId === t);
  }
  async append(v: RuntimeEvent) {
    this.v.push(structuredClone(v));
  }
  async events(id: string) {
    return this.v
      .filter((x) => x.executionId === id)
      .sort((a, b) => a.sequence - b.sequence);
  }
  async saveSession(v: RuntimeSession) {
    const existing = [...this.s.values()].find(
      (item) =>
        item.tenantId === v.tenantId &&
        item.botId === v.botId &&
        item.conversationKey === v.conversationKey,
    );
    const value = existing ? { ...v, id: existing.id } : v;
    this.s.set(value.id, structuredClone(value));
    return value;
  }
  async session(id: string) {
    const value = this.s.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async sessionByConversation(t: string, b: string, key: string) {
    const value = [...this.s.values()].find(
      (item) =>
        item.tenantId === t && item.botId === b && item.conversationKey === key,
    );
    return value ? structuredClone(value) : undefined;
  }
  async sessions(filter: { tenantId?: string; botId?: string } = {}) {
    return [...this.s.values()]
      .filter(
        (item) =>
          (!filter.tenantId || item.tenantId === filter.tenantId) &&
          (!filter.botId || item.botId === filter.botId),
      )
      .map((item) => structuredClone(item));
  }
  async removeSession(id: string) {
    return this.s.delete(id);
  }
}
