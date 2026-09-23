import { DurableObject } from "cloudflare:workers";
import type { Env, Permit, Priority } from "./types";
import { never, sleep, sqlFirst, sqlRows } from "./safe";
import { log } from "./http";
import { freshLimit, observe, parseLimitHeaders, take, type LimitState } from "./limit";
import { requestColo } from "./colo";
import { headersRecord } from "./raw";

/**
 * Work-stealing budget + colo directory.
 * Rate is discovered (headers / implied req/s), not configured.
 * Colos are discovered from request.cf.colo as they appear.
 */
export class ArchiveEgress extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS attempts (
          at INTEGER NOT NULL,
          method TEXT,
          url TEXT,
          status INTEGER,
          classified TEXT,
          ms INTEGER,
          colo TEXT,
          headers TEXT
        );
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS colos (
          colo TEXT PRIMARY KEY,
          last_seen INTEGER NOT NULL,
          ok INTEGER DEFAULT 0,
          limited INTEGER DEFAULT 0
        );
      `);
    } catch {
      /* ignore */
    }
  }

  private limitState(): LimitState {
    const raw = sqlFirst<{ v: string }>(this.ctx.storage.sql.exec(`SELECT v FROM kv WHERE k = 'limit'`));
    if (raw?.v) {
      try {
        return JSON.parse(raw.v) as LimitState;
      } catch {
        /* reset */
      }
    }
    return freshLimit(Date.now());
  }

  private saveLimit(state: LimitState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO kv (k,v) VALUES ('limit', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(state),
    );
  }

  take(priority: Priority): Permit {
    try {
      const got = take(this.limitState(), Date.now(), priority);
      this.saveLimit(got.state);
      return { ok: got.ok, tokens: got.state.tokens, reason: got.reason };
    } catch {
      return { ok: true, tokens: 0, reason: "ungated" };
    }
  }

  async takeWaiting(priority: Priority): Promise<Permit> {
    for (let i = 0; i < 6; i++) {
      const p = this.take(priority);
      if (p.ok || priority === "refresh") return p;
      await sleep(200);
    }
    return this.take(priority);
  }

  seeColo(colo: string | null | undefined): void {
    const id = (colo || "").trim().toUpperCase();
    if (!id || id === "LOCAL") return;
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO colos (colo, last_seen, ok, limited) VALUES (?, ?, 0, 0)
         ON CONFLICT(colo) DO UPDATE SET last_seen = excluded.last_seen`,
        id,
        Date.now(),
      );
    } catch {
      /* ignore */
    }
  }

  note(row: {
    method?: string;
    url?: string;
    status?: number;
    classified?: string;
    ms?: number;
    colo?: string;
    headers?: Headers | Record<string, string>;
  }): void {
    const now = Date.now();
    const headers = headersRecord(row.headers);
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO attempts (at, method, url, status, classified, ms, colo, headers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        now,
        row.method ?? null,
        row.url ?? null,
        row.status ?? null,
        row.classified ?? null,
        row.ms ?? null,
        row.colo ?? null,
        Object.keys(headers).length ? JSON.stringify(headers) : null,
      );
    } catch {
      /* ignore */
    }
    this.seeColo(row.colo);
    try {
      const next = observe(this.limitState(), {
        at: now,
        classified: row.classified || "network",
        headers: Object.keys(headers).length ? headers : null,
      });
      this.saveLimit(next);
      if (row.colo && (row.classified === "ok" || row.classified === "missing" || row.classified === "ratelimit" || row.classified === "blocked")) {
        const field = row.classified === "ratelimit" || row.classified === "blocked" ? "limited" : "ok";
        this.ctx.storage.sql.exec(`UPDATE colos SET ${field} = ${field} + 1, last_seen = ? WHERE colo = ?`, now, row.colo.toUpperCase());
      }
    } catch {
      /* ignore */
    }
  }

  colos(): string[] {
    try {
      return sqlRows<{ colo: string }>(
        this.ctx.storage.sql.exec(`SELECT colo FROM colos ORDER BY last_seen DESC LIMIT 32`),
      ).map((r) => String(r.colo));
    } catch {
      return [];
    }
  }

  stats(): unknown {
    return {
      recent: sqlRows(this.ctx.storage.sql.exec(`SELECT * FROM attempts ORDER BY at DESC LIMIT 25`)),
      limit: this.limitState(),
      colos: this.colos(),
      parsed: parseLimitHeaders({}),
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/take") {
        const body = (await request.json().catch(() => ({}))) as { priority?: Priority; wait?: boolean };
        const priority = body.priority === "refresh" || body.priority === "missing" ? body.priority : "new";
        const permit = body.wait === false ? this.take(priority) : await this.takeWaiting(priority);
        return Response.json(permit);
      }
      if (url.pathname === "/note") {
        const body = (await request.json().catch(() => ({}))) as {
          method?: string;
          url?: string;
          status?: number;
          classified?: string;
          ms?: number;
          colo?: string;
          headers?: Record<string, string>;
        };
        this.note(body);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/seen") {
        const body = (await request.json().catch(() => ({}))) as { colo?: string };
        this.seeColo(body.colo || requestColo(request));
        return Response.json({ ok: true, colos: this.colos() });
      }
      if (url.pathname === "/colos") {
        return Response.json({ colos: this.colos() });
      }
      if (url.pathname === "/stats") {
        return Response.json(this.stats());
      }
    } catch (err) {
      log("gate-error", { error: err instanceof Error ? err.message : String(err) });
      return Response.json({ ok: true, tokens: 0, reason: "ungated" });
    }
    return new Response("not found", { status: 404 });
  }
}

export async function takePermit(env: Env, priority: Priority, wait: boolean): Promise<Permit> {
  return never(async () => {
    const stub = env.ARCHIVE_EGRESS.get(env.ARCHIVE_EGRESS.idFromName("gate"));
    const res = await stub.fetch("https://gate/take", {
      method: "POST",
      body: JSON.stringify({ priority, wait }),
    });
    const json = (await res.json()) as Permit;
    if (json && typeof json.ok === "boolean") return json;
    return { ok: true, tokens: 0, reason: "ungated" };
  }, { ok: true, tokens: 0, reason: "ungated" });
}

export async function noteAttempt(
  env: Env,
  row: {
    method?: string;
    url?: string;
    status?: number;
    classified?: string;
    ms?: number;
    colo?: string;
    headers?: Headers | Record<string, string>;
  },
): Promise<void> {
  await never(async () => {
    const stub = env.ARCHIVE_EGRESS.get(env.ARCHIVE_EGRESS.idFromName("gate"));
    await stub.fetch("https://gate/note", {
      method: "POST",
      body: JSON.stringify({ ...row, headers: headersRecord(row.headers) }),
    });
  }, undefined);
}

export async function seeColo(env: Env, colo: string | null): Promise<void> {
  if (!colo) return;
  await never(async () => {
    const stub = env.ARCHIVE_EGRESS.get(env.ARCHIVE_EGRESS.idFromName("gate"));
    await stub.fetch("https://gate/seen", { method: "POST", body: JSON.stringify({ colo }) });
  }, undefined);
}
