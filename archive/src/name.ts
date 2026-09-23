import { DurableObject } from "cloudflare:workers";
import type { ClientPolicy, Env, EgressResult, NameState, Priority } from "./types";
import { LOOKUP_NAME, egressFirst } from "./egress";
import { isAbsentStatus, isTerminal } from "./absent";
import { PARSER, classify, foldName, identity } from "./parse";
import { asUuid, hashIp } from "./ids";
import { log } from "./http";
import { asRecord, asString, envInt, never, sqlFirst, sqlRows } from "./safe";
import { noteAttempt, takePermit } from "./gate";
import { dump, ensureHttp, insertHttp, listHttp } from "./store";
import { meta } from "./raw";

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
      ensureHttp(this.ctx.storage.sql);
    } catch {
      /* ignore */
    }
  }

  private getState(name: string): NameState {
    const ver = sqlFirst<{ v: string }>(this.ctx.storage.sql.exec(`SELECT v FROM kv WHERE k = 'parser'`));
    const rows = listHttp(this.ctx.storage.sql, 200);
    if (rows.length && ver?.v !== PARSER) {
      const folded = foldName(name, rows);
      this.putState(folded);
      this.putParser();
      return folded;
    }
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

  private putParser(): void {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO kv (k,v) VALUES ('parser', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        PARSER,
      );
    } catch {
      /* ignore */
    }
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

  private async applyObservation(state: NameState, now: number, egress: EgressResult): Promise<NameState> {
    if (egress.response) await insertHttp(this.ctx.storage.sql, egress.response);
    this.putParser();
    const rec = asRecord(egress.json);
    const parsed = egress.response && egress.body != null ? identity(egress.response, egress.body) : null;
    const uuid = rec ? asUuid(asString(rec.id) || "", false, "any") : parsed?.id ?? null;
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

    // 403/429/5xx must not overwrite a known uuid or be cached as a miss
    // (991e1e9, issues #28 #40 #54). Only a terminal Mojang answer commits state.
    if (isTerminal(egress.classified)) {
      state.lastRefreshAt = now;
      state.lastStatus = egress.status;
      if (egress.classified === "ok" && uuid) {
        if (!state.firstAliveAt) state.firstAliveAt = now;
        state.lastAliveAt = now;
        state.uuid = uuid;
      } else if (egress.classified === "missing") {
        if (!state.firstMissingAt) state.firstMissingAt = now;
        state.lastMissingAt = now;
      }
      this.putState(state);
    }
    return state;
  }

  async resolve(name: string, ip: string, colo?: string | null): Promise<{
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
    const missing = isAbsentStatus(state.lastStatus);

    if (hasUuid && age < freshMs) {
      return { state, policy, cache: "fresh" };
    }

    if (hasUuid) {
      if (policy.allowRefresh) {
        this.ctx.waitUntil(this.refreshInBackground(name, colo));
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

    const egress = await this.lookup(name, colo);
    state = await this.applyObservation(state, Date.now(), egress);
    log("name", { name, status: egress.status, classified: egress.classified, uuid: state.uuid, method: egress.method });
    return { state, policy, cache: "miss", egress };
  }

  private async refreshInBackground(name: string, colo?: string | null): Promise<void> {
    try {
      const permit = await takePermit(this.env, "refresh", false);
      if (!permit.ok) return;
      const egress = await this.lookup(name, colo);
      await this.applyObservation(this.getState(name), Date.now(), egress);
    } catch {
      /* never throw from waitUntil */
    }
  }

  private async lookup(name: string, colo?: string | null): Promise<EgressResult> {
    const urls = LOOKUP_NAME.map((prefix) => prefix + encodeURIComponent(name));
    const egress = await never(() => egressFirst(urls, this.env, { prefer: colo }), {
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
      colo: colo || undefined,
      headers: egress.response?.headers,
    });
    return egress;
  }

  async history(): Promise<unknown> {
    const http = listHttp(this.ctx.storage.sql, 200);
    const folded = http.length ? foldName("", http) : this.getState("");
    const observations = http.length
      ? http.map((r) => ({
          at: r.at,
          status: r.response.status,
          uuid: identity(r.response, r.body)?.id ?? null,
          source: meta(r.response, "via"),
          classified: classify(r.response, r.body),
        }))
      : sqlRows(this.ctx.storage.sql.exec(`SELECT at, status, uuid, source, classified FROM observations ORDER BY at ASC`));
    return { parser: PARSER, state: folded, observations, http: http.map(dump) };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/resolve") {
        const body = (await request.json().catch(() => ({}))) as { name?: string; ip?: string; colo?: string };
        return Response.json(await this.resolve(String(body.name || ""), String(body.ip || "unknown"), body.colo));
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
