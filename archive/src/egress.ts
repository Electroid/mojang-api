import { connect } from "cloudflare:sockets";
import type { Classify, EgressAttempt, EgressMethod, EgressResult, Env } from "./types";
import { log } from "./http";
import { looksLikeHtml, sleep, tryJson } from "./safe";

const UA = "mojang-archive/0.2 (+https://api.ashcon.app/mojang/v4)";

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

export const LOOKUP_NAME = [
  "https://api.minecraftservices.com/minecraft/profile/lookup/name/",
  "https://api.mojang.com/minecraft/profile/lookup/name/",
  "https://api.mojang.com/users/profiles/minecraft/",
];

export const LOOKUP_UUID = [
  "https://api.minecraftservices.com/minecraft/profile/lookup/",
  "https://api.mojang.com/minecraft/profile/lookup/",
];

export function sessionUrl(uuid: string, signed = true): string {
  const base = `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`;
  return signed ? `${base}?unsigned=false` : base;
}

export function classify(status: number | null, body: string | null, contentType?: string | null): Classify {
  if (status == null) return "network";
  if (looksLikeHtml(body, contentType)) return status === 403 || status === 429 ? "blocked" : "garbage";
  if (status === 200) {
    const parsed = tryJson(body);
    if (parsed && typeof parsed === "object") return "ok";
    if (body && body.trim() && !tryJson(body)) return "garbage";
    return "ok";
  }
  if (status === 204) return "missing";
  if (status === 404) return "missing";
  if (status === 400) return "invalid";
  if (status === 403) return "blocked";
  if (status === 429) return "ratelimit";
  if (status >= 500) return "upstream";
  if (status >= 400) return "upstream";
  return "garbage";
}

/** Terminal = we got a real Mojang answer (including miss/invalid). Do NOT treat 403/429 as terminal. */
export function isTerminal(c: Classify): boolean {
  return c === "ok" || c === "missing" || c === "invalid";
}

function proxies(envProxies: string | undefined): string[] {
  return (envProxies || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseMethods(raw: string | undefined): EgressMethod[] {
  const allowed: EgressMethod[] = ["socket", "proxy", "fetch"];
  const list = (raw || "socket,proxy,fetch")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is EgressMethod => (allowed as string[]).includes(s));
  return list.length ? list : ["fetch"];
}

function finish(a: EgressAttempt & { body?: string; contentType?: string }): EgressAttempt & { body?: string } {
  a.classified = classify(a.status, a.body ?? null, a.contentType);
  a.ok = isTerminal(a.classified as Classify);
  return a;
}

async function fetchDirect(url: string): Promise<EgressAttempt & { body?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const body = await res.text().catch(() => "");
    return finish({
      method: "fetch",
      url,
      status: res.status,
      ms: Date.now() - t0,
      bodyPreview: body.slice(0, 180),
      body,
      contentType: res.headers.get("content-type"),
      ok: false,
    });
  } catch (err) {
    return {
      method: "fetch",
      url,
      ok: false,
      status: null,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      classified: "network",
    };
  }
}

async function fetchProxy(prefix: string, url: string): Promise<EgressAttempt & { body?: string }> {
  const t0 = Date.now();
  const via = prefix + encodeURIComponent(url);
  try {
    const res = await fetch(via, {
      headers: { Accept: "application/json", "User-Agent": UA },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const body = await res.text().catch(() => "");
    return finish({
      method: "proxy",
      url,
      via,
      status: res.status,
      ms: Date.now() - t0,
      bodyPreview: body.slice(0, 180),
      body,
      contentType: res.headers.get("content-type"),
      ok: false,
    });
  } catch (err) {
    return {
      method: "proxy",
      url,
      via,
      ok: false,
      status: null,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      classified: "network",
    };
  }
}

function decodeChunked(body: string): string {
  try {
    let out = "";
    let i = 0;
    while (i < body.length) {
      const nl = body.indexOf("\r\n", i);
      if (nl < 0) return body;
      const size = parseInt(body.slice(i, nl).split(";")[0].trim(), 16);
      if (!Number.isFinite(size)) return body;
      if (size === 0) break;
      out += body.slice(nl + 2, nl + 2 + size);
      i = nl + 2 + size + 2;
    }
    return out || body;
  } catch {
    return body;
  }
}

async function fetchSocket(url: string): Promise<EgressAttempt & { body?: string }> {
  const t0 = Date.now();
  let socket: ReturnType<typeof connect> | null = null;
  try {
    const u = new URL(url);
    const port = u.protocol === "https:" ? 443 : 80;
    socket = connect(
      { hostname: u.hostname, port },
      { secureTransport: u.protocol === "https:" ? "on" : "off" },
    );
    void socket.closed.catch(() => undefined);
    const opened = socket.opened.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const timed = sleep(2500).then(() => ({ ok: false as const, e: new Error("socket timeout") }));
    const outcome = await Promise.race([opened, timed]);
    if (!outcome.ok) throw outcome.e instanceof Error ? outcome.e : new Error(String(outcome.e));
    const info = outcome.v;
    const path = `${u.pathname}${u.search}`;
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${u.hostname}`,
      `User-Agent: ${UA}`,
      "Accept: application/json",
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(req));
    await writer.close().catch(() => undefined);
    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = [];
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      let readResult: { done: boolean; value?: Uint8Array } = { done: true };
      try {
        readResult = await Promise.race([
          reader.read(),
          sleep(4000).then(() => ({ done: true as const, value: undefined })),
        ]);
      } catch {
        break;
      }
      if (readResult.done) break;
      if (readResult.value) chunks.push(readResult.value);
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    void socket.close().catch(() => undefined);
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    const raw = new TextDecoder().decode(buf);
    const sep = raw.indexOf("\r\n\r\n");
    const head = sep >= 0 ? raw.slice(0, sep) : raw;
    let body = sep >= 0 ? raw.slice(sep + 4) : "";
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(head);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const te = /transfer-encoding:\s*chunked/i.test(head);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
    if (te) body = decodeChunked(body);
    return finish({
      method: "socket",
      url,
      status,
      ms: Date.now() - t0,
      localAddress: (info as { localAddress?: string } | undefined)?.localAddress ?? null,
      remoteAddress: (info as { remoteAddress?: string } | undefined)?.remoteAddress ?? null,
      bodyPreview: body.slice(0, 180),
      body,
      contentType: ct,
      ok: false,
    });
  } catch (err) {
    try {
      void socket?.close().catch(() => undefined);
    } catch {
      /* ignore */
    }
    return {
      method: "socket",
      url,
      ok: false,
      status: null,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      classified: "network",
    };
  }
}

function toResult(a: EgressAttempt & { body?: string }, attempts: EgressAttempt[]): EgressResult {
  const classified = (a.classified as Classify) || classify(a.status, a.body ?? null);
  return {
    ok: isTerminal(classified),
    status: a.status || 0,
    body: a.body ?? null,
    json: classified === "missing" && a.status === 204 ? null : tryJson(a.body ?? null),
    method: a.method,
    via: a.via,
    attempts,
    localAddress: a.localAddress,
    classified,
  };
}

export async function egressGet(url: string, env: Pick<Env, "EGRESS_PROXIES" | "EGRESS_METHODS"> | string, methods?: EgressMethod[]): Promise<EgressResult> {
  const envProxies = typeof env === "string" ? env : env.EGRESS_PROXIES;
  const want = methods ?? (typeof env === "string" ? ["socket", "proxy", "fetch"] : parseMethods(env.EGRESS_METHODS));
  const attempts: EgressAttempt[] = [];
  const proxyList = proxies(envProxies);

  for (const method of want) {
    try {
      if (method === "socket") {
        const a = await fetchSocket(url);
        attempts.push(a);
        log("egress", { method: a.method, status: a.status, ms: a.ms, classified: a.classified, error: a.error });
        if (a.ok) return toResult(a, attempts);
      } else if (method === "proxy") {
        for (const prefix of proxyList) {
          const a = await fetchProxy(prefix, url);
          attempts.push(a);
          log("egress", { method: a.method, status: a.status, ms: a.ms, classified: a.classified, via: a.via, error: a.error });
          if (a.ok) return toResult(a, attempts);
        }
      } else if (method === "fetch") {
        const a = await fetchDirect(url);
        attempts.push(a);
        log("egress", { method: a.method, status: a.status, ms: a.ms, classified: a.classified, error: a.error });
        if (a.ok) return toResult(a, attempts);
      }
    } catch (err) {
      attempts.push({
        method,
        url,
        ok: false,
        status: null,
        ms: 0,
        error: err instanceof Error ? err.message : String(err),
        classified: "network",
      });
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    status: last?.status || 502,
    body: last && "bodyPreview" in last ? null : null,
    json: last ? tryJson((last as EgressAttempt & { body?: string }).body ?? null) : null,
    method: "none",
    attempts,
    classified: (last?.classified as Classify) || "network",
  };
}

/** Try several equivalent Mojang URLs; first terminal answer wins. Failover is not extra rate-limit work. */
export async function egressFirst(urls: string[], env: Pick<Env, "EGRESS_PROXIES" | "EGRESS_METHODS">): Promise<EgressResult> {
  const attempts: EgressAttempt[] = [];
  let last: EgressResult | null = null;
  for (const url of urls) {
    const r = await egressGet(url, env);
    attempts.push(...r.attempts);
    last = { ...r, attempts };
    if (isTerminal(r.classified)) return last;
  }
  return last || { ok: false, status: 502, body: null, json: null, method: "none", attempts, classified: "network" };
}

export async function experimentAll(env: Pick<Env, "EGRESS_PROXIES" | "EGRESS_METHODS">): Promise<unknown> {
  const targets = [
    "https://api.minecraftservices.com/minecraft/profile/lookup/name/Notch",
    "https://api.mojang.com/minecraft/profile/lookup/name/Notch",
    "https://api.mojang.com/users/profiles/minecraft/Notch",
    "https://api.minecraftservices.com/minecraft/profile/lookup/069a79f444e94726a5befca90e38aaf5",
    "https://sessionserver.mojang.com/session/minecraft/profile/069a79f444e94726a5befca90e38aaf5?unsigned=false",
    "https://api.mojang.com/user/profiles/069a79f444e94726a5befca90e38aaf5/names",
    "https://api.minecraftservices.com/minecraft/profile/lookup/name/ThisNameDoesNotExist0",
  ];
  const results = [];
  for (const url of targets) {
    results.push(await egressGet(url, env));
  }
  return { from: "cloudflare-worker", results };
}
