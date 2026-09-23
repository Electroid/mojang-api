import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { HTTP_TABLE, originRequest, meta } from "./raw";
import { proxyFetch, proxySocket } from "./transport";
import { insertHttp } from "./store";
import { log } from "./http";
import { sqlRows } from "./safe";

/**
 * Colo-local dumb HTTP proxy. Speaks Request in, Response out.
 * Extra routing lives on x-archive-* headers. First get(idFromName("colo:"+IATA))
 * with no locationHint pins near that colo.
 */
export class ArchiveTcp extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    try {
      this.ctx.storage.sql.exec(HTTP_TABLE);
    } catch {
      /* ignore */
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/hits") {
        return Response.json({
          http: sqlRows(this.ctx.storage.sql.exec(`SELECT id, at, url, status FROM http ORDER BY at DESC LIMIT 20`)),
        });
      }
      const target = proxyTarget(request);
      if (!target) return failed("missing x-archive-target");
      const mode = request.headers.get("x-archive-mode") || "socket";
      const via = request.headers.get("x-archive-via") || mode;
      const origin = originRequest(target, request);
      const res = mode === "fetch" ? await proxyFetch(origin, via) : await proxySocket(origin, via);
      await insertHttp(this.ctx.storage.sql, res, target);
      log("proxy", { via: meta(res, "via"), status: res.status, ms: meta(res, "ms"), error: meta(res, "error") });
      return res;
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Origin URL is the Request URL, or x-archive-target when the DO is addressed at /proxy. */
function proxyTarget(request: Request): string {
  const tagged = request.headers.get("x-archive-target");
  if (tagged) return tagged;
  try {
    const u = new URL(request.url);
    if (u.pathname === "/proxy" || u.pathname === "/get" || u.pathname === "/hits") return "";
    if (u.protocol === "http:" || u.protocol === "https:") return request.url;
  } catch {
    /* ignore */
  }
  return "";
}

function failed(message: string): Response {
  const headers = new Headers({ "x-archive-error": message });
  return new Response("", { status: 502, headers });
}
