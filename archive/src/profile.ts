import { DurableObject } from "cloudflare:workers";
import type { ClientPolicy, Env, EgressResult, SessionProfile } from "./types";
import { sessionUrl, LOOKUP_UUID, egressFirst, egressGet } from "./egress";
import { asUuid, hashIp } from "./ids";
import { log } from "./http";
import { estimatedCreatedAt } from "./compat";
import { asArray, asRecord, asString, envInt, never, sqlFirst, sqlRows, tryJson } from "./safe";
import { PIXEL_PNG_B64, httpsRewrite } from "./skins";
import { noteAttempt, takePermit } from "./gate";

interface Snap {
  at: number;
  username: string;
  profile: SessionProfile;
  skinB64: string | null;
  capeB64: string | null;
}

export class ArchiveProfile extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          username TEXT,
          profile_json TEXT NOT NULL,
          skin_b64 TEXT,
          cape_b64 TEXT,
          source TEXT
        );
        CREATE TABLE IF NOT EXISTS history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          changed_at INTEGER
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

  private meta(): Record<string, number | string | null> {
    const raw = sqlFirst<{ v: string }>(this.ctx.storage.sql.exec(`SELECT v FROM kv WHERE k = 'meta'`));
    if (raw?.v) {
      try {
        return JSON.parse(raw.v);
      } catch {
        return {};
      }
    }
    return {};
  }

  private setMeta(m: Record<string, number | string | null>): void {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO kv (k,v) VALUES ('meta', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        JSON.stringify(m),
      );
    } catch {
      /* ignore */
    }
  }

  private async clientPolicy(ip: string): Promise<ClientPolicy> {
    return never(async () => {
      const stub = this.env.ARCHIVE_CLIENTS.get(this.env.ARCHIVE_CLIENTS.idFromName(hashIp(ip)));
      return (await stub.fetch("https://client/policy")).json() as Promise<ClientPolicy>;
    }, { hitsLastMinute: 0, maxStaleMs: 60 * 60_000, allowRefresh: true });
  }

  private latest(): Snap | null {
    const row = sqlFirst<{
      at: number;
      username: string;
      profile_json: string;
      skin_b64: string | null;
      cape_b64: string | null;
    }>(this.ctx.storage.sql.exec(`SELECT at, username, profile_json, skin_b64, cape_b64 FROM snapshots ORDER BY at DESC LIMIT 1`));
    if (!row) return null;
    const profile = (tryJson(row.profile_json) || {}) as SessionProfile;
    return {
      at: Number(row.at) || 0,
      username: row.username || asString(profile.name) || "unknown",
      profile,
      skinB64: row.skin_b64,
      capeB64: row.cape_b64,
    };
  }

  private async maybeBuffer(url: string | undefined | null): Promise<string | null> {
    if (!url || typeof url !== "string") return null;
    const candidates = [httpsRewrite(url), url].filter((u, i, a) => a.indexOf(u) === i);
    for (const u of candidates) {
      try {
        const res = await fetch(u, { cf: { cacheTtl: 86400, cacheEverything: true } });
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength) continue;
        let bin = "";
        for (const b of buf) bin += String.fromCharCode(b);
        return btoa(bin);
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async load(uuid: string, ip: string): Promise<{
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
    const m = this.meta();
    if (!m.firstSeenAt) {
      m.firstSeenAt = now;
      this.setMeta(m);
    }
    const snap = this.latest();
    const age = snap ? now - snap.at : Number.POSITIVE_INFINITY;
    const freshMs = envInt(this.env.FRESH_MS, 5 * 60_000);

    if (snap && age < freshMs) {
      return this.pack(uuid, snap, m, policy, "fresh", 200);
    }
    if (snap) {
      if (policy.allowRefresh) this.ctx.waitUntil(this.refreshInBackground(uuid));
      return this.pack(uuid, snap, m, policy, "stale", 200);
    }

    const permit = await takePermit(this.env, "new", true);
    if (!permit.ok) {
      return {
        uuid,
        username: null,
        profile: null,
        skinB64: null,
        capeB64: null,
        history: [],
        firstSeenAt: (m.firstSeenAt as number) || null,
        firstAliveAt: null,
        firstMissingAt: (m.firstMissingAt as number) || null,
        lastMissingAt: (m.lastMissingAt as number) || null,
        createdAt: null,
        cache: "miss",
        status: 429,
        classified: "ratelimit",
        policy,
      };
    }
    const fetched = await this.refresh(uuid, now, m);
    if (fetched.ok && fetched.snap) return this.pack(uuid, fetched.snap, m, policy, "miss", 200, fetched.method);
    return {
      uuid,
      username: (m.username as string) || null,
      profile: null,
      skinB64: null,
      capeB64: null,
      history: this.historyRows(),
      firstSeenAt: (m.firstSeenAt as number) || null,
      firstAliveAt: (m.firstAliveAt as number) || null,
      firstMissingAt: (m.firstMissingAt as number) || null,
      lastMissingAt: (m.lastMissingAt as number) || null,
      createdAt: estimatedCreatedAt((m.firstMissingAt as number) || null, (m.firstAliveAt as number) || null),
      cache: "miss",
      status: fetched.status,
      classified: fetched.classified,
      policy,
      method: fetched.method,
    };
  }

  private async refreshInBackground(uuid: string): Promise<void> {
    try {
      const permit = await takePermit(this.env, "refresh", false);
      if (!permit.ok) return;
      await this.refresh(uuid, Date.now(), this.meta());
    } catch {
      /* never throw from waitUntil */
    }
  }

  private async refresh(uuid: string, now: number, m: Record<string, number | string | null>): Promise<{
    ok: boolean;
    snap: Snap | null;
    status: number;
    classified?: string;
    method?: string;
  }> {
    const session = await never(() => egressGet(sessionUrl(uuid), this.env), {
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
    });

    if (session.classified === "ok" && session.json) {
      const profile = asRecord(session.json) as SessionProfile;
      const username = asString(profile.name) || "unknown";
      const texturesProp = asArray(profile.properties).find((p) => asString(asRecord(p)?.name) === "textures");
      let skinUrl: string | undefined;
      let capeUrl: string | undefined;
      const value = asString(asRecord(texturesProp)?.value);
      if (value) {
        try {
          const decoded = tryJson(atob(value));
          const textures = asRecord(asRecord(decoded)?.textures);
          skinUrl = asString(asRecord(textures?.SKIN)?.url) || undefined;
          capeUrl = asString(asRecord(textures?.CAPE)?.url) || undefined;
        } catch {
          /* ignore */
        }
      }
      const skinB64 = (await this.maybeBuffer(skinUrl)) || (skinUrl ? null : PIXEL_PNG_B64);
      const capeB64 = await this.maybeBuffer(capeUrl);
      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO snapshots (at, username, profile_json, skin_b64, cape_b64, source) VALUES (?, ?, ?, ?, ?, ?)`,
          now,
          username,
          JSON.stringify(profile),
          skinB64,
          capeB64,
          `${session.method}`,
        );
        const lastName = sqlFirst<{ username: string }>(this.ctx.storage.sql.exec(`SELECT username FROM history ORDER BY id DESC LIMIT 1`));
        if (!lastName || lastName.username !== username) {
          this.ctx.storage.sql.exec(`INSERT INTO history (username, changed_at) VALUES (?, ?)`, username, lastName ? now : null);
        }
      } catch {
        /* still return the snapshot we have in memory */
      }
      if (!m.firstAliveAt) m.firstAliveAt = now;
      m.lastAliveAt = now;
      m.username = username;
      m.lastRefreshAt = now;
      this.setMeta(m);
      log("profile", { uuid, status: 200, method: session.method, username });
      return {
        ok: true,
        snap: { at: now, username, profile, skinB64, capeB64 },
        status: 200,
        classified: "ok",
        method: String(session.method),
      };
    }

    if (session.classified === "missing" || session.classified === "invalid") {
      if (session.classified === "missing" && !m.firstMissingAt) m.firstMissingAt = now;
      if (session.classified === "missing") m.lastMissingAt = now;
      m.lastRefreshAt = now;
      this.setMeta(m);
      return { ok: false, snap: null, status: session.status === 204 ? 404 : session.status || 404, classified: session.classified, method: String(session.method) };
    }

    if (!session.ok) {
      const lookup = await never(
        () => egressFirst(LOOKUP_UUID.map((p) => p + uuid), this.env),
        { ok: false, status: 502, body: null, json: null, method: "none" as const, attempts: [], classified: "network" as const },
      );
      if (lookup.classified === "missing") {
        if (!m.firstMissingAt) m.firstMissingAt = now;
        m.lastMissingAt = now;
        m.lastRefreshAt = now;
        this.setMeta(m);
        return { ok: false, snap: null, status: 404, classified: "missing", method: String(lookup.method) };
      }
    }

    return { ok: false, snap: null, status: session.status || 502, classified: session.classified, method: String(session.method) };
  }

  private historyRows(): Array<{ username: string; changedAt: number | null }> {
    try {
      return sqlRows<{ username: string; changed_at: number | null }>(
        this.ctx.storage.sql.exec(`SELECT username, changed_at FROM history ORDER BY id ASC`),
      ).map((r) => ({ username: String(r.username), changedAt: r.changed_at }));
    } catch {
      return [];
    }
  }

  private pack(
    uuid: string,
    snap: Snap,
    m: Record<string, number | string | null>,
    policy: ClientPolicy,
    cache: string,
    status: number,
    method?: string,
  ) {
    const history = this.historyRows();
    return {
      uuid: asUuid(uuid, false, "any") || uuid,
      username: snap.username,
      profile: snap.profile,
      skinB64: snap.skinB64,
      capeB64: snap.capeB64,
      history: history.length ? history : [{ username: snap.username, changedAt: null }],
      firstSeenAt: (m.firstSeenAt as number) || null,
      firstAliveAt: (m.firstAliveAt as number) || null,
      firstMissingAt: (m.firstMissingAt as number) || null,
      lastMissingAt: (m.lastMissingAt as number) || null,
      createdAt: estimatedCreatedAt((m.firstMissingAt as number) || null, (m.firstAliveAt as number) || null),
      cache,
      status,
      policy,
      method,
    };
  }

  async snapshots(): Promise<unknown> {
    return {
      meta: this.meta(),
      history: this.historyRows(),
      snapshots: sqlRows(this.ctx.storage.sql.exec(`SELECT id, at, username, source FROM snapshots ORDER BY at ASC`)),
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/load") {
        const body = (await request.json().catch(() => ({}))) as { uuid?: string; ip?: string };
        return Response.json(await this.load(String(body.uuid || ""), String(body.ip || "unknown")));
      }
      if (url.pathname === "/snapshots") {
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
