import { DurableObject } from "cloudflare:workers";
import type { ClientPolicy, Env } from "./types";
import { sqlFirst } from "./safe";

const MINUTE = 60_000;

export class ArchiveClient extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS hits (at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS hits_at ON hits(at);
      `);
    } catch {
      /* first-request schema issues must not crash */
    }
  }

  async policy(): Promise<ClientPolicy> {
    try {
      const now = Date.now();
      this.ctx.storage.sql.exec(`INSERT INTO hits (at) VALUES (?)`, now);
      this.ctx.storage.sql.exec(`DELETE FROM hits WHERE at < ?`, now - 10 * MINUTE);
      const row = sqlFirst<{ n: number }>(this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM hits WHERE at >= ?`, now - MINUTE));
      const hitsLastMinute = Number(row?.n || 0);
      if (hitsLastMinute >= 30) {
        return { hitsLastMinute, maxStaleMs: 7 * 24 * 60 * MINUTE, allowRefresh: false };
      }
      if (hitsLastMinute >= 10) {
        return { hitsLastMinute, maxStaleMs: 24 * 60 * MINUTE, allowRefresh: true };
      }
      return { hitsLastMinute, maxStaleMs: 60 * MINUTE, allowRefresh: true };
    } catch {
      return { hitsLastMinute: 0, maxStaleMs: 60 * MINUTE, allowRefresh: true };
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname === "/policy") {
        return Response.json(await this.policy());
      }
    } catch {
      /* fall through */
    }
    return new Response("not found", { status: 404 });
  }
}
