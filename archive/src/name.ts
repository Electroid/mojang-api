import { DurableObject } from "cloudflare:workers";
import type { ClientPolicy, Env, EgressResult, NameState, Priority } from "./types";
import { LOOKUP_NAME, egressFirst } from "./egress";
import { isAbsentStatus } from "./absent";
import { PARSER, classify, foldName, identity } from "./parse";
import { asUuid, hashIp } from "./ids";
import { log } from "./http";
import { envInt, never } from "./safe";
import { noteAttempt, takePermit } from "./gate";
import { dump, ensureHttp, insertHttp, listHttp } from "./store";
import { kindOf, meta } from "./raw";

export class ArchiveName extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureHttp(this.ctx.storage.sql);
  }

  private ledger(): ReturnType<typeof listHttp> {
    return listHttp(this.ctx.storage.sql);
  }

  private fold(name: string): NameState {
    return foldName(name, this.ledger());
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

  private async record(name: string, egress: EgressResult): Promise<NameState> {
    if (egress.response) await insertHttp(this.ctx.storage.sql, egress.response);
    return this.fold(name);
  }

  async resolve(name: string, ip: string, colo?: string | null): Promise<{
    state: NameState;
    policy: ClientPolicy;
    cache: string;
    egress?: EgressResult;
  }> {
    const policy = await this.clientPolicy(ip);
    const now = Date.now();
    let state = this.fold(name);

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
    state = await this.record(name, egress);
    log("name", { name, status: egress.status, classified: egress.classified, uuid: state.uuid, method: egress.method });
    return { state, policy, cache: "miss", egress };
  }

  private async refreshInBackground(name: string, colo?: string | null): Promise<void> {
    try {
      const permit = await takePermit(this.env, "refresh", false);
      if (!permit.ok) return;
      await this.record(name, await this.lookup(name, colo));
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
    const ledger = this.ledger();
    const folded = foldName("", ledger);
    return {
      parser: PARSER,
      state: folded,
      observations: ledger.map((r) => ({
        at: r.at,
        status: r.response.status,
        uuid: identity(r.response, r.body)?.id ?? null,
        source: meta(r.response, "via"),
        kind: kindOf(r),
        classified: classify(r.response, r.body),
      })),
      ledger: ledger.map(dump),
      http: ledger.map(dump),
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/resolve") {
        const body = (await request.json().catch(() => ({}))) as { name?: string; ip?: string; colo?: string };
        return Response.json(await this.resolve(String(body.name || ""), String(body.ip || "unknown"), body.colo));
      }
      if (url.pathname === "/history" || url.pathname === "/ledger") {
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
