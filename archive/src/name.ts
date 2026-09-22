import { DurableObject } from "cloudflare:workers";
import type { ClientPolicy, Env, EgressResult, NameState, Priority } from "./types";
import { LOOKUP_NAME, egressFirst } from "./egress";
import { asUuid, hashIp } from "./ids";
import { log } from "./http";
import { asRecord, asString, envInt, never, sqlFirst, sqlRows } from "./safe";
import { noteAttempt, takePermit } from "./gate";

export class ArchiveName extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          status INTEGER NOT NULL,
          uuid TEXT,
          source TEXT,
          classified TEXT
        );
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
      `);
    } catch {
      /* ignore */
    }
  }

  private getState(name: string): NameState {
    const raw = sqlFirst<{ v: string }>(this.ctx.storage.sql.exec(`SELECT v FROM kv WHERE k = 'state'`));
    if (raw?.v) {
      try {
        return { name, ...JSON.parse(raw.v) } as NameState;
      } catch {
        /* reset */
      }
    }
    return {
      name,
      uuid: null,
      lastStatus: null,
      firstSeenAt: null,
      firstAliveAt: null,
      firstMissingAt: null,
      lastAliveAt: null,
      lastMissingAt: null,
      lastRefreshAt: null,
    };
  }

  private putState(state: NameState): void {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO kv (k,v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        JSON.stringify(state),
      );
    } catch {
      /* ignore */
    }
  }

  private async clientPolicy(ip: string): Promise<ClientPolicy> {
    return never(async () => {
      const stub = this.env.ARCHIVE_CLIENTS.get(this.env.ARCHIVE_CLIENTS.idFromName(hashIp(ip)));
      const res = await stub.fetch("https://client/policy");
      const json = (await res.json()) as ClientPolicy;
      if (json && typeof json.allowRefresh === "boolean") return json;
      throw new Error("bad policy");
    }, { hitsLastMinute: 0, maxStaleMs: 60 * 60_000, allowRefresh: true });
  }

  private applyObservation(state: NameState, now: number, egress: EgressResult): NameState {
    const rec = asRecord(egress.json);
    const uuid = rec ? asUuid(asString(rec.id) || "", false, "any") : null;
    state.lastRefreshAt = now;
    state.lastStatus = egress.status;
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO observations (at, status, uuid, source, classified) VALUES (?, ?, ?, ?, ?)`,
        now,
        egress.status,
        uuid,
        `${egress.method}:${egress.via || "direct"}`,
        egress.classified,
      );
    } catch {
      /* ignore */
    }

    if (egress.classified === "ok" && uuid) {
      if (!state.firstAliveAt) state.firstAliveAt = now;
      state.lastAliveAt = now;
      state.uuid = uuid;
    } else if (egress.classified === "missing") {
      if (!state.firstMissingAt) state.firstMissingAt = now;
      state.lastMissingAt = now;
    }
    this.putState(state);
    return state;
  }

  async resolve(name: string, ip: string): Promise<{
    state: NameState;
    policy: ClientPolicy;
    cache: string;
    egress?: EgressResult;
  }> {
    const policy = await this.clientPolicy(ip);
    const now = Date.now();
    let state = this.getState(name);
    if (!state.firstSeenAt) {
      state.firstSeenAt = now;
      this.putState(state);
    }

    const freshMs = envInt(this.env.FRESH_MS, 5 * 60_000);
    const negativeMs = envInt(this.env.NEGATIVE_MS, 60_000);
    const age = state.lastRefreshAt ? now - state.lastRefreshAt : Number.POSITIVE_INFINITY;
    const hasUuid = Boolean(state.uuid);
    const missing = state.lastStatus === 404 || state.lastStatus === 204;

    if (hasUuid && age < freshMs) {
      return { state, policy, cache: "fresh" };
    }

    if (hasUuid) {
      if (policy.allowRefresh) {
        this.ctx.waitUntil(this.refreshInBackground(name));
      }
      return { state, policy, cache: "stale" };
    }

    if (missing && age < negativeMs) {
      return { state, policy, cache: "negative" };
    }

    const priority: Priority = missing ? "missing" : "new";
    const wait = priority === "new";
    const permit = await takePermit(this.env, priority, wait);
    if (!permit.ok) {
      if (missing) return { state, policy, cache: "negative" };
      return { state, policy, cache: "miss" };
    }

    const egress = await this.lookup(name);
    state = this.applyObservation(state, Date.now(), egress);
    log("name", { name, status: egress.status, classified: egress.classified, uuid: state.uuid, method: egress.method });
    return { state, policy, cache: "miss", egress };
  }

  private async refreshInBackground(name: string): Promise<void> {
    try {
      const permit = await takePermit(this.env, "refresh", false);
      if (!permit.ok) return;
      const egress = await this.lookup(name);
      this.applyObservation(this.getState(name), Date.now(), egress);
    } catch {
      /* never throw from waitUntil */
    }
  }

  private async lookup(name: string): Promise<EgressResult> {
    const urls = LOOKUP_NAME.map((prefix) => prefix + encodeURIComponent(name));
    const egress = await never(() => egressFirst(urls, this.env), {
      ok: false,
      status: 502,
      body: null,
      json: null,
      method: "none" as const,
      attempts: [],
      classified: "network" as const,
    });
    await noteAttempt(this.env, {
      method: String(egress.method),
      url: urls[0],
      status: egress.status,
      classified: egress.classified,
      ms: egress.attempts.reduce((s, a) => s + a.ms, 0),
    });
    return egress;
  }

  async history(): Promise<unknown> {
    const rows = sqlRows(this.ctx.storage.sql.exec(`SELECT at, status, uuid, source, classified FROM observations ORDER BY at ASC`));
    return { state: this.getState(""), observations: rows };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/resolve") {
        const body = (await request.json().catch(() => ({}))) as { name?: string; ip?: string };
        return Response.json(await this.resolve(String(body.name || ""), String(body.ip || "unknown")));
      }
      if (url.pathname === "/history") {
        return Response.json(await this.history());
      }
    } catch (err) {
      log("name-error", { error: err instanceof Error ? err.message : String(err) });
      return Response.json({
        state: {
          name: "",
          uuid: null,
          lastStatus: 500,
          firstSeenAt: null,
          firstAliveAt: null,
          firstMissingAt: null,
          lastAliveAt: null,
          lastMissingAt: null,
          lastRefreshAt: null,
        },
        policy: { hitsLastMinute: 0, maxStaleMs: 0, allowRefresh: false },
        cache: "error",
      });
    }
    return new Response("not found", { status: 404 });
  }
}
