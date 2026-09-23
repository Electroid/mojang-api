import { DurableObject } from "cloudflare:workers";
import type { ClientPolicy, Env, EgressResult, SessionProfile } from "./types";
import { sessionUrl, LOOKUP_UUID, egressFirst, egressGet } from "./egress";
import { asUuid, hashIp } from "./ids";
import { log } from "./http";
import { estimatedCreatedAt } from "./compat";
import { envInt, never } from "./safe";
import { PIXEL_PNG_B64, httpsRewrite } from "./skins";
import { noteAttempt, takePermit } from "./gate";
import { dump, ensureHttp, insertHttp, listHttp } from "./store";
import { kindOf, meta, originRequest, stamp } from "./raw";
import { PARSER, decodedTexturesResponse, foldProfile, hasTexture, session as sessionFromResponse, textureUrls } from "./parse";
import { proxyFetch } from "./transport";

export class ArchiveProfile extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureHttp(this.ctx.storage.sql);
  }

  private ledger() {
    return listHttp(this.ctx.storage.sql);
  }

  private fold(uuid: string) {
    return foldProfile(uuid, this.ledger());
  }

  private async clientPolicy(ip: string): Promise<ClientPolicy> {
    return never(async () => {
      const stub = this.env.ARCHIVE_CLIENTS.get(this.env.ARCHIVE_CLIENTS.idFromName(hashIp(ip)));
      return (await stub.fetch("https://client/policy")).json() as Promise<ClientPolicy>;
    }, { hitsLastMinute: 0, maxStaleMs: 60 * 60_000, allowRefresh: true });
  }

  async load(uuid: string, ip: string, colo?: string | null): Promise<{
    uuid: string;
    username: string | null;
    profile: SessionProfile | null;
    skinB64: string | null;
    capeB64: string | null;
    history: Array<{ username: string; changedAt: number | null }>;
    firstSeenAt: number | null;
    firstAliveAt: number | null;
    firstMissingAt: number | null;
    lastMissingAt: number | null;
    createdAt: number | null;
    cache: string;
    status: number;
    classified?: string;
    policy: ClientPolicy;
    method?: string;
  }> {
    const policy = await this.clientPolicy(ip);
    const now = Date.now();
    const folded = this.fold(uuid);
    const age = folded.lastRefreshAt ? now - folded.lastRefreshAt : Number.POSITIVE_INFINITY;
    const freshMs = envInt(this.env.FRESH_MS, 5 * 60_000);

    if (folded.profile && age < freshMs) {
      return this.pack(uuid, folded, policy, "fresh", 200);
    }
    if (folded.profile) {
      if (policy.allowRefresh) this.ctx.waitUntil(this.refreshInBackground(uuid, colo));
      return this.pack(uuid, folded, policy, "stale", 200);
    }

    const permit = await takePermit(this.env, "new", true);
    if (!permit.ok) {
      return this.pack(uuid, folded, policy, "miss", 429, "ratelimit");
    }
    const fetched = await this.refresh(uuid, colo);
    const next = this.fold(uuid);
    if (fetched.ok && next.profile) return this.pack(uuid, next, policy, "miss", 200, fetched.classified, fetched.method);
    return this.pack(
      uuid,
      next,
      policy,
      "miss",
      fetched.classified === "missing" ? 404 : fetched.status,
      fetched.classified,
      fetched.method,
    );
  }

  private async refreshInBackground(uuid: string, colo?: string | null): Promise<void> {
    try {
      const permit = await takePermit(this.env, "refresh", false);
      if (!permit.ok) return;
      await this.refresh(uuid, colo);
    } catch {
      /* never throw from waitUntil */
    }
  }

  private async refresh(uuid: string, colo?: string | null): Promise<{
    ok: boolean;
    status: number;
    classified?: string;
    method?: string;
  }> {
    const session = await never(() => egressGet(sessionUrl(uuid), this.env, { prefer: colo }), {
      ok: false,
      status: 502,
      body: null,
      json: null,
      method: "none" as const,
      attempts: [],
      classified: "network" as const,
    });
    await noteAttempt(this.env, {
      method: String(session.method),
      url: sessionUrl(uuid),
      status: session.status,
      classified: session.classified,
      ms: session.attempts.reduce((s, a) => s + a.ms, 0),
      colo: colo || undefined,
      headers: session.response?.headers,
    });

    if (session.response) await insertHttp(this.ctx.storage.sql, session.response);
    const parsedSession = session.response && session.body != null ? sessionFromResponse(session.response, session.body) : null;
    const profile = parsedSession;
    const now = Date.now();

    if (session.classified === "ok" && profile) {
      const decoded = decodedTexturesResponse(profile, now, uuid);
      if (decoded) await insertHttp(this.ctx.storage.sql, decoded);
      await this.ledgerTextures(textureUrls(profile));
      log("profile", { uuid, status: 200, method: session.method, username: String(profile.name || "") });
      return { ok: true, status: 200, classified: "ok", method: String(session.method) };
    }

    if (session.classified === "missing" || session.classified === "invalid") {
      return {
        ok: false,
        status: session.classified === "missing" ? 404 : session.status || 400,
        classified: session.classified,
        method: String(session.method),
      };
    }

    if (!session.ok) {
      const lookup = await never(
        () => egressFirst(LOOKUP_UUID.map((p) => p + uuid), this.env, { prefer: colo }),
        { ok: false, status: 502, body: null, json: null, method: "none" as const, attempts: [], classified: "network" as const },
      );
      if (lookup.response) await insertHttp(this.ctx.storage.sql, lookup.response);
      if (lookup.classified === "missing") {
        return { ok: false, status: 404, classified: "missing", method: String(lookup.method) };
      }
    }

    return { ok: false, status: session.status || 502, classified: session.classified, method: String(session.method) };
  }

  /** Fetch skin/cape bytes and append the exact CDN Response to the ledger. */
  private async ledgerTextures(urls: { skin?: string; cape?: string }): Promise<void> {
    const rows = this.ledger();
    for (const url of [urls.skin, urls.cape]) {
      if (!url || hasTexture(rows, url)) continue;
      const res = await this.fetchTexture(url);
      await insertHttp(this.ctx.storage.sql, res, meta(res, "url") || url);
    }
  }

  private async fetchTexture(url: string): Promise<Response> {
    const t0 = Date.now();
    const candidates = [httpsRewrite(url), url].filter((u, i, a) => a.indexOf(u) === i);
    for (const u of candidates) {
      try {
        const res = await proxyFetch(originRequest(u), "texture");
        return stamp(res, { kind: "texture", url: u, at: Date.now(), ms: Date.now() - t0 });
      } catch {
        /* try next */
      }
    }
    return stamp(new Response("", { status: 502 }), {
      kind: "texture",
      via: "fetch",
      error: "texture-fetch",
      url,
      at: Date.now(),
      ms: Date.now() - t0,
    });
  }

  private pack(
    uuid: string,
    folded: ReturnType<typeof foldProfile>,
    policy: ClientPolicy,
    cache: string,
    status: number,
    classified?: string,
    method?: string,
  ) {
    const username = folded.username;
    const profile = folded.profile;
    const ok = Boolean(profile && username) && status === 200;
    return {
      uuid: asUuid(uuid, false, "any") || uuid,
      username: username,
      profile,
      skinB64: folded.skinB64 || (ok ? PIXEL_PNG_B64 : null),
      capeB64: folded.capeB64,
      history: folded.history.length && username ? folded.history : username ? [{ username, changedAt: null }] : [],
      firstSeenAt: folded.firstSeenAt,
      firstAliveAt: folded.firstAliveAt,
      firstMissingAt: folded.firstMissingAt,
      lastMissingAt: folded.lastMissingAt,
      createdAt: estimatedCreatedAt(folded.firstMissingAt, folded.firstAliveAt),
      cache,
      status,
      classified: classified || folded.classified || undefined,
      policy,
      method,
    };
  }

  async snapshots(): Promise<unknown> {
    const ledger = this.ledger();
    const folded = foldProfile("", ledger);
    return {
      parser: PARSER,
      state: folded,
      ledger: ledger.map(dump),
      http: ledger.map(dump),
      kinds: ledger.map((r) => ({ at: r.at, url: r.url, status: r.response.status, kind: kindOf(r), via: meta(r.response, "via") })),
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/load") {
        const body = (await request.json().catch(() => ({}))) as { uuid?: string; ip?: string; colo?: string };
        return Response.json(await this.load(String(body.uuid || ""), String(body.ip || "unknown"), body.colo));
      }
      if (url.pathname === "/snapshots" || url.pathname === "/ledger" || url.pathname === "/history") {
        return Response.json(await this.snapshots());
      }
    } catch (err) {
      log("profile-error", { error: err instanceof Error ? err.message : String(err) });
      return Response.json({
        uuid: "",
        username: null,
        profile: null,
        skinB64: null,
        capeB64: null,
        history: [],
        firstSeenAt: null,
        firstAliveAt: null,
        firstMissingAt: null,
        lastMissingAt: null,
        createdAt: null,
        cache: "error",
        status: 500,
        policy: { hitsLastMinute: 0, maxStaleMs: 0, allowRefresh: false },
      });
    }
    return new Response("not found", { status: 404 });
  }
}
