import { connect } from "cloudflare:sockets";
import { bodyInit, headersFromHttpHead, originRequest, stamp } from "./raw";
import { sleep } from "./safe";

try {
  addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const msg = String((ev as { reason?: { message?: string } }).reason?.message || ev.reason || "");
    if (msg.includes("Network connection lost") || msg.includes("Socket closed") || msg.includes("socket timeout")) {
      ev.preventDefault();
    }
  });
} catch {
  /* ignore */
}

function decodeChunked(body: Uint8Array): Uint8Array {
  try {
    const text = new TextDecoder("latin1").decode(body);
    const parts: number[] = [];
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf("\r\n", i);
      if (nl < 0) return body;
      const size = parseInt(text.slice(i, nl).split(";")[0].trim(), 16);
      if (!Number.isFinite(size)) return body;
      if (size === 0) break;
      const start = nl + 2;
      for (let k = 0; k < size && start + k < text.length; k++) parts.push(text.charCodeAt(start + k) & 255);
      i = start + size + 2;
    }
    return new Uint8Array(parts);
  } catch {
    return body;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}

function splitHttp(raw: Uint8Array): { head: string; body: Uint8Array } {
  const latin = new TextDecoder("latin1").decode(raw);
  const sep = latin.indexOf("\r\n\r\n");
  if (sep < 0) return { head: latin, body: new Uint8Array() };
  return { head: latin.slice(0, sep), body: raw.slice(sep + 4) };
}

function failed(request: Request, via: string, err: unknown, ms: number): Response {
  return stamp(new Response("", { status: 502 }), {
    via,
    error: err instanceof Error ? err.message : String(err),
    ms,
    at: Date.now(),
    url: request.url,
  });
}

/** Isolate fetch. Returns the upstream Response plus x-archive-* meta. */
export async function proxyFetch(request: Request, via = "fetch"): Promise<Response> {
  const t0 = Date.now();
  try {
    const res = await fetch(request, { cf: { cacheTtl: 0, cacheEverything: false } });
    return stamp(res, { via, ms: Date.now() - t0, at: Date.now(), url: request.url });
  } catch (err) {
    return failed(request, via, err, Date.now() - t0);
  }
}

/** Raw TLS HTTP/1.1 GET framed into a Response. No Mojang interpretation. */
export async function proxySocket(request: Request, via = "socket"): Promise<Response> {
  const t0 = Date.now();
  let socket: ReturnType<typeof connect> | null = null;
  try {
    const u = new URL(request.url);
    const port = u.protocol === "https:" ? 443 : 80;
    socket = connect({ hostname: u.hostname, port }, { secureTransport: u.protocol === "https:" ? "on" : "off" });
    void socket.closed.catch(() => undefined);
    const opened = socket.opened.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const timed = sleep(3000).then(() => ({ ok: false as const, e: new Error("socket timeout") }));
    const outcome = await Promise.race([opened, timed]);
    if (!outcome.ok) throw outcome.e instanceof Error ? outcome.e : new Error(String(outcome.e));
    const info = outcome.v as { localAddress?: string; remoteAddress?: string };
    const path = `${u.pathname}${u.search}` || "/";
    const ua = request.headers.get("user-agent") || "Java/17.0.12";
    const accept = request.headers.get("accept") || "application/json";
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${u.hostname}`,
      `User-Agent: ${ua}`,
      `Accept: ${accept}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(req));
    await writer.close().catch(() => undefined);
    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      let step: { done: boolean; value?: Uint8Array } = { done: true };
      try {
        step = await Promise.race([
          reader.read(),
          sleep(4000).then(() => ({ done: true as const, value: undefined })),
        ]);
      } catch {
        break;
      }
      if (step.done) break;
      if (step.value) chunks.push(step.value);
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    void socket.close().catch(() => undefined);

    const buf = concat(chunks);
    const preview = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 16));
    if (preview.startsWith("PRI * HTTP/2") || (buf.length > 0 && buf[0] === 0x00 && buf[1] === 0x00)) {
      return failed(request, via, "http2", Date.now() - t0);
    }
    const { head, body: bodyBytes } = splitHttp(buf);
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(head);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const headers = headersFromHttpHead(head);
    const te = /chunked/i.test(headers.get("transfer-encoding") || "");
    let payload = te ? decodeChunked(bodyBytes) : bodyBytes;
    const cl = Number(headers.get("content-length"));
    if (Number.isFinite(cl) && cl >= 0 && cl <= payload.byteLength) payload = payload.slice(0, cl);
    const body = new TextDecoder("utf-8", { fatal: false }).decode(payload);
    const code = status >= 200 && status <= 599 ? status : 502;
    return stamp(new Response(bodyInit(code, body), { status: code, headers }), {
      via,
      ms: Date.now() - t0,
      at: Date.now(),
      url: request.url,
      "local-address": info.localAddress ?? null,
      "remote-address": info.remoteAddress ?? null,
      error: status >= 200 && status <= 599 ? null : "bad-status",
    });
  } catch (err) {
    try {
      void socket?.close().catch(() => undefined);
    } catch {
      /* ignore */
    }
    return failed(request, via, err, Date.now() - t0);
  }
}

export { originRequest };
