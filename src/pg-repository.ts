import { Pool } from "pg";
import type { RuntimeRepository } from "./repository.js";
import type {
  BotDefinition,
  Execution,
  RuntimeEvent,
  RuntimeSession,
} from "./types.js";
const schema = `CREATE SCHEMA IF NOT EXISTS rt;CREATE TABLE IF NOT EXISTS rt.bots(id text PRIMARY KEY,tenant_id text NOT NULL,enabled boolean NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL);CREATE INDEX IF NOT EXISTS bots_tenant_idx ON rt.bots(tenant_id,enabled);CREATE TABLE IF NOT EXISTS rt.executions(id uuid PRIMARY KEY,tenant_id text NOT NULL,bot_id text NOT NULL,status text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL);CREATE INDEX IF NOT EXISTS executions_lookup_idx ON rt.executions(tenant_id,bot_id,created_at DESC);CREATE TABLE IF NOT EXISTS rt.events(id uuid PRIMARY KEY,execution_id uuid NOT NULL REFERENCES rt.executions(id) ON DELETE CASCADE,sequence integer NOT NULL,type text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL,UNIQUE(execution_id,sequence));CREATE TABLE IF NOT EXISTS rt.sessions(id uuid PRIMARY KEY,tenant_id text NOT NULL,bot_id text NOT NULL,conversation_key text NOT NULL,data jsonb NOT NULL,last_active_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,UNIQUE(tenant_id,bot_id,conversation_key));CREATE INDEX IF NOT EXISTS sessions_scope_idx ON rt.sessions(tenant_id,bot_id,last_active_at DESC);`;
export class PgRuntimeRepository implements RuntimeRepository {
  private p: Pool;
  constructor(url: string) {
    this.p = new Pool({ connectionString: url, max: 10 });
  }
  async migrate() {
    await this.p.query(schema);
  }
  async ping() {
    try {
      await this.p.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    await this.p.end();
  }
  async saveBot(v: BotDefinition) {
    await this.p.query(
      "INSERT INTO rt.bots(id,tenant_id,enabled,data,updated_at)VALUES($1,$2,$3,$4,$5)ON CONFLICT(id)DO UPDATE SET tenant_id=$2,enabled=$3,data=$4,updated_at=$5",
      [v.id, v.tenantId, v.enabled, v, v.updatedAt],
    );
    return v;
  }
  async bot(id: string) {
    return (await this.p.query("SELECT data FROM rt.bots WHERE id=$1", [id]))
      .rows[0]?.data;
  }
  async bots(t?: string) {
    return (
      await this.p.query(
        `SELECT data FROM rt.bots ${t ? "WHERE tenant_id=$1" : ""} ORDER BY updated_at DESC`,
        t ? [t] : [],
      )
    ).rows.map((x) => x.data);
  }
  async removeBot(id: string) {
    return (
      (await this.p.query("DELETE FROM rt.bots WHERE id=$1", [id])).rowCount ===
      1
    );
  }
  async saveExecution(v: Execution) {
    await this.p.query(
      "INSERT INTO rt.executions(id,tenant_id,bot_id,status,data,created_at)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(id)DO UPDATE SET status=$4,data=$5",
      [v.id, v.tenantId, v.botId, v.status, v, v.createdAt],
    );
    return v;
  }
  async execution(id: string) {
    return (
      await this.p.query("SELECT data FROM rt.executions WHERE id=$1", [id])
    ).rows[0]?.data;
  }
  async executions(t?: string) {
    return (
      await this.p.query(
        `SELECT data FROM rt.executions ${t ? "WHERE tenant_id=$1" : ""} ORDER BY created_at DESC`,
        t ? [t] : [],
      )
    ).rows.map((x) => x.data);
  }
  async append(v: RuntimeEvent) {
    await this.p.query(
      "INSERT INTO rt.events(id,execution_id,sequence,type,data,created_at)VALUES($1,$2,$3,$4,$5,$6)",
      [v.id, v.executionId, v.sequence, v.type, v, v.createdAt],
    );
  }
  async events(id: string) {
    return (
      await this.p.query(
        "SELECT data FROM rt.events WHERE execution_id=$1 ORDER BY sequence",
        [id],
      )
    ).rows.map((x) => x.data);
  }
  async saveSession(v: RuntimeSession) {
    const row = (
      await this.p.query(
        "INSERT INTO rt.sessions(id,tenant_id,bot_id,conversation_key,data,last_active_at,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(tenant_id,bot_id,conversation_key)DO UPDATE SET data=jsonb_set(EXCLUDED.data,'{id}',to_jsonb(rt.sessions.id::text)),last_active_at=$6,expires_at=$7 RETURNING data",
        [
          v.id,
          v.tenantId,
          v.botId,
          v.conversationKey,
          v,
          v.lastActiveAt,
          v.expiresAt,
        ],
      )
    ).rows[0].data;
    return row;
  }
  async session(id: string) {
    return (
      await this.p.query("SELECT data FROM rt.sessions WHERE id=$1", [id])
    ).rows[0]?.data;
  }
  async sessionByConversation(t: string, b: string, key: string) {
    return (
      await this.p.query(
        "SELECT data FROM rt.sessions WHERE tenant_id=$1 AND bot_id=$2 AND conversation_key=$3",
        [t, b, key],
      )
    ).rows[0]?.data;
  }
  async sessions(filter: { tenantId?: string; botId?: string } = {}) {
    const values: string[] = [];
    const where: string[] = [];
    if (filter.tenantId) {
      values.push(filter.tenantId);
      where.push(`tenant_id=$${values.length}`);
    }
    if (filter.botId) {
      values.push(filter.botId);
      where.push(`bot_id=$${values.length}`);
    }
    return (
      await this.p.query(
        `SELECT data FROM rt.sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_active_at DESC`,
        values,
      )
    ).rows.map((x) => x.data);
  }
  async removeSession(id: string) {
    return (
      (await this.p.query("DELETE FROM rt.sessions WHERE id=$1", [id]))
        .rowCount === 1
    );
  }
}
