import { DurableObject } from "cloudflare:workers";
import type { Env, Permit, Priority } from "./types";
import { envInt, never, sleep, sqlFirst, sqlRows } from "./safe";
import { log } from "./http";

interface Bucket {
  tokens: number;
  updated: number;
}

/**
 * Rate-limit budget, work-stealing style:
 *  - "new" lookups may spend the reserved tokens.
 *  - "refresh" of already-archived identities may not. They skip and serve stale.
 * This DO does NOT perform Mojang I/O, so it never blocks a new name behind a refresh fetch.
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
          ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          priority INTEGER NOT NULL,
          kind TEXT,
          target TEXT,
          created_at INTEGER NOT NULL,
          done INTEGER DEFAULT 0
        );
      `);
    } catch {
      /* ignore */
    }
  }

  private bucket(): Bucket {
    const now = Date.now();
    const raw = sqlFirst<{ v: string }>(this.ctx.storage.sql.exec(`SELECT v FROM kv WHERE k = 'bucket'`));
    if (raw?.v) {
      try {
        return JSON.parse(raw.v) as Bucket;
      } catch {
        /* reset */
      }
    }
    return { tokens: 8, updated: now };
  }

  private save(bucket: Bucket): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO kv (k,v) VALUES ('bucket', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(bucket),
    );
  }

  private refill(): Bucket {
    const now = Date.now();
    const bucket = this.bucket();
    const rate = 1.2;
    const cap = 8;
    const elapsed = Math.max(0, (now - (bucket.updated || now)) / 1000);
    bucket.tokens = Math.min(cap, (bucket.tokens || 0) + elapsed * rate);
    bucket.updated = now;
    return bucket;
  }

  take(priority: Priority): Permit {
    try {
      const reserve = envInt(this.env.TOKEN_RESERVE, 4);
      const bucket = this.refill();
      const needReserve = priority === "refresh" || priority === "missing";
      const minLeft = needReserve ? reserve : 0;
      if (bucket.tokens < 1 + minLeft && needReserve) {
        this.save(bucket);
        return { ok: false, tokens: bucket.tokens, reason: "reserved_for_new" };
      }
      if (bucket.tokens < 1) {
        this.save(bucket);
        return { ok: false, tokens: bucket.tokens, reason: "empty" };
      }
      bucket.tokens -= 1;
      this.save(bucket);
      return { ok: true, tokens: bucket.tokens, reason: "ok" };
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

  note(row: { method?: string; url?: string; status?: number; classified?: string; ms?: number }): void {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO attempts (at, method, url, status, classified, ms) VALUES (?, ?, ?, ?, ?, ?)`,
        Date.now(),
        row.method ?? null,
        row.url ?? null,
        row.status ?? null,
        row.classified ?? null,
        row.ms ?? null,
      );
    } catch {
      /* ignore */
    }
  }

  stats(): unknown {
    const recent = sqlRows(this.ctx.storage.sql.exec(`SELECT * FROM attempts ORDER BY at DESC LIMIT 25`));
    const bucket = this.refill();
    this.save(bucket);
    return { recent, bucket, reserve: envInt(this.env.TOKEN_RESERVE, 4) };
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
        };
        this.note(body);
        return Response.json({ ok: true });
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

export async function noteAttempt(env: Env, row: { method?: string; url?: string; status?: number; classified?: string; ms?: number }): Promise<void> {
  await never(async () => {
    const stub = env.ARCHIVE_EGRESS.get(env.ARCHIVE_EGRESS.idFromName("gate"));
    await stub.fetch("https://gate/note", { method: "POST", body: JSON.stringify(row) });
  }, undefined);
}
