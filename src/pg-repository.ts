import { Pool } from "pg";
import type { RuntimeRepository } from "./repository.js";
import type {
  BotDefinition,
  Execution,
  RuntimeEvent,
  RuntimeProfile,
  RuntimeProviderRecord,
  RuntimeSession,
  SessionLedgerEvent,
} from "./types.js";
const schema = `CREATE SCHEMA IF NOT EXISTS rt;CREATE TABLE IF NOT EXISTS rt.bots(id text PRIMARY KEY,tenant_id text NOT NULL,enabled boolean NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL);CREATE INDEX IF NOT EXISTS bots_tenant_idx ON rt.bots(tenant_id,enabled);CREATE TABLE IF NOT EXISTS rt.executions(id uuid PRIMARY KEY,tenant_id text NOT NULL,bot_id text NOT NULL,status text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL);CREATE INDEX IF NOT EXISTS executions_lookup_idx ON rt.executions(tenant_id,bot_id,created_at DESC);CREATE TABLE IF NOT EXISTS rt.events(id uuid PRIMARY KEY,execution_id uuid NOT NULL REFERENCES rt.executions(id) ON DELETE CASCADE,sequence integer NOT NULL,type text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL,UNIQUE(execution_id,sequence));CREATE TABLE IF NOT EXISTS rt.sessions(id uuid PRIMARY KEY,tenant_id text NOT NULL,bot_id text NOT NULL,conversation_key text NOT NULL,data jsonb NOT NULL,last_active_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,UNIQUE(tenant_id,bot_id,conversation_key));CREATE INDEX IF NOT EXISTS sessions_scope_idx ON rt.sessions(tenant_id,bot_id,last_active_at DESC);CREATE TABLE IF NOT EXISTS rt.runtime_providers(id text PRIMARY KEY,state text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL);CREATE TABLE IF NOT EXISTS rt.runtime_profiles(id uuid PRIMARY KEY,tenant_id text NOT NULL,enabled boolean NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL);CREATE INDEX IF NOT EXISTS runtime_profiles_tenant_idx ON rt.runtime_profiles(tenant_id,enabled);CREATE TABLE IF NOT EXISTS rt.session_events(id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES rt.sessions(id) ON DELETE CASCADE,sequence bigint NOT NULL,event_type text NOT NULL,execution_id uuid NOT NULL REFERENCES rt.executions(id) ON DELETE CASCADE,idempotency_key text NOT NULL UNIQUE,data jsonb NOT NULL,created_at timestamptz NOT NULL,UNIQUE(session_id,sequence));CREATE INDEX IF NOT EXISTS session_events_lookup_idx ON rt.session_events(session_id,sequence);`;
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
  async saveRuntimeProvider(v: RuntimeProviderRecord) {
    await this.p.query(
      "INSERT INTO rt.runtime_providers(id,state,data,updated_at)VALUES($1,$2,$3,$4)ON CONFLICT(id)DO UPDATE SET state=$2,data=$3,updated_at=$4",
      [v.descriptor.providerId, v.lifecycleState, v, v.updatedAt],
    );
    return v;
  }
  async runtimeProvider(id: string) {
    return (
      await this.p.query("SELECT data FROM rt.runtime_providers WHERE id=$1", [
        id,
      ])
    ).rows[0]?.data;
  }
  async runtimeProviders() {
    return (
      await this.p.query("SELECT data FROM rt.runtime_providers ORDER BY id")
    ).rows.map((row) => row.data);
  }
  async saveRuntimeProfile(v: RuntimeProfile) {
    await this.p.query(
      "INSERT INTO rt.runtime_profiles(id,tenant_id,enabled,data,updated_at)VALUES($1,$2,$3,$4,$5)ON CONFLICT(id)DO UPDATE SET tenant_id=$2,enabled=$3,data=$4,updated_at=$5",
      [v.id, v.tenantId, v.enabled, v, v.updatedAt],
    );
    return v;
  }
  async runtimeProfile(id: string) {
    return (
      await this.p.query("SELECT data FROM rt.runtime_profiles WHERE id=$1", [
        id,
      ])
    ).rows[0]?.data;
  }
  async runtimeProfiles(tenantId?: string) {
    return (
      await this.p.query(
        `SELECT data FROM rt.runtime_profiles ${tenantId ? "WHERE tenant_id=$1" : ""} ORDER BY updated_at DESC`,
        tenantId ? [tenantId] : [],
      )
    ).rows.map((row) => row.data);
  }
  async removeRuntimeProfile(id: string) {
    return (
      (await this.p.query("DELETE FROM rt.runtime_profiles WHERE id=$1", [id]))
        .rowCount === 1
    );
  }
  async appendSessionEvent(v: Omit<SessionLedgerEvent, "sequence">) {
    const client = await this.p.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM rt.sessions WHERE id=$1 FOR UPDATE", [
        v.sessionId,
      ]);
      const sequence = Number(
        (
          await client.query(
            "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM rt.session_events WHERE session_id=$1",
            [v.sessionId],
          )
        ).rows[0].sequence,
      );
      const event: SessionLedgerEvent = { ...v, sequence };
      const result = await client.query(
        "INSERT INTO rt.session_events(id,session_id,sequence,event_type,execution_id,idempotency_key,data,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8)ON CONFLICT(idempotency_key)DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING data",
        [
          event.id,
          event.sessionId,
          event.sequence,
          event.eventType,
          event.executionId,
          event.idempotencyKey,
          event,
          event.createdAt,
        ],
      );
      await client.query("COMMIT");
      return result.rows[0].data as SessionLedgerEvent;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async sessionEvents(sessionId: string, after = 0, limit = 200) {
    return (
      await this.p.query(
        "SELECT data FROM rt.session_events WHERE session_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3",
        [sessionId, after, limit],
      )
    ).rows.map((row) => row.data);
  }
}
