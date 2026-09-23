/**
 * Wire format for the dumb HTTP layer: standard Request / Response.
 * Extra fields live on headers named x-archive-*. Parsers must not require them.
 */

export const X = "x-archive-";

export function originRequest(url: string, from?: Request): Request {
  const texture = kindFromUrl(url) === "texture";
  return new Request(url, {
    method: "GET",
    headers: {
      Accept: from?.headers.get("accept") || (texture ? "*/*" : "application/json"),
      "User-Agent": from?.headers.get("user-agent") || "Java/17.0.12",
    },
  });
}

export function stamp(res: Response, extra: Record<string, string | number | null | undefined>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) {
    if (v == null || v === "") continue;
    headers.set(X + k, String(v));
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function meta(res: Response, key: string): string | null {
  return res.headers.get(X + key);
}

export function cacheTtlMs(headers: Headers): number | null {
  const cc = headers.get("cache-control");
  if (!cc) return null;
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, 3600_000) : null;
}

export function headersRecord(input: Headers | Record<string, string | undefined | null> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (typeof (input as Headers).forEach === "function" && typeof (input as Headers).get === "function") {
    (input as Headers).forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(input as Record<string, string | undefined | null>)) {
    if (v) out[k] = v;
  }
  return out;
}

export function headersFromHttpHead(head: string): Headers {
  const headers = new Headers();
  for (const line of head.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) {
      try {
        headers.append(k, v);
      } catch {
        /* skip invalid */
      }
    }
  }
  return headers;
}

export function encodeHeaders(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((v, k) => {
    lines.push(`${k}: ${v}`);
  });
  return lines.join("\r\n");
}

export function decodeHeaders(text: string): Headers {
  const headers = new Headers();
  for (const line of String(text || "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    try {
      headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    } catch {
      /* skip */
    }
  }
  return headers;
}

const NULL_BODY = new Set([204, 205, 304]);

export function bodyInit(status: number, body: string | null | undefined): BodyInit | null {
  if (NULL_BODY.has(status)) return null;
  return body ?? "";
}

export function bytesToB64(buf: Uint8Array): string {
  let bin = "";
  const n = 0x8000;
  for (let i = 0; i < buf.length; i += n) {
    bin += String.fromCharCode(...buf.subarray(i, i + n));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isBinary(bytes: Uint8Array, contentType: string): boolean {
  if (/image|octet-stream|png|jpeg|webp|avif/i.test(contentType)) return true;
  if (/json|text|xml|javascript|urlencoded/i.test(contentType)) return false;
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  return bytes.includes(0);
}

export function kindFromUrl(url: string): string {
  const u = (url || "").toLowerCase();
  if (u.startsWith("x-archive://decode")) return "decode";
  if (/sessionserver\.mojang\.com|\/session\/minecraft\/profile/.test(u)) return "session";
  if (/textures\.minecraft\.net|assets\.mojang\.com/.test(u)) return "texture";
  if (/\/lookup\/name|\/users\/profiles\/minecraft\//.test(u)) return "lookup";
  if (/\/minecraft\/profile\/lookup\//.test(u)) return "uuid";
  return "http";
}

export function kindOf(row: { response: Response; url: string }): string {
  return meta(row.response, "kind") || kindFromUrl(row.url || meta(row.response, "url") || "");
}

/** Persist a Response as HTTP status + header block + body. Binary bodies are base64 + x-archive-body. */
export async function freeze(res: Response): Promise<{ status: number; headers: string; body: string }> {
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  const headers = new Headers(res.headers);
  const binary = isBinary(bytes, headers.get("content-type") || "");
  if (binary) {
    headers.set(X + "body", "base64");
    return { status: res.status, headers: encodeHeaders(headers), body: bytesToB64(bytes) };
  }
  return {
    status: res.status,
    headers: encodeHeaders(headers),
    body: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
  };
}

/** Rehydrate a stored HTTP message. Invalid statuses become 502 with x-archive-error. */
export function thaw(status: number, headers: string, body: string): Response {
  const h = decodeHeaders(headers);
  const code = status >= 200 && status <= 599 ? status : 502;
  if (status < 200 || status > 599) h.set(X + "error", h.get(X + "error") || "bad-status");
  if (h.get(X + "body") === "base64") {
    return new Response(b64ToBytes(body), { status: code, headers: h });
  }
  return new Response(bodyInit(code, body), { status: code, headers: h });
}

export type StoredHttp = { response: Response; body: string; url: string; at: number };

export function stored(
  status: number,
  body: string,
  opts: { url?: string; at?: number; headers?: HeadersInit; via?: string; kind?: string } = {},
): StoredHttp {
  const url = opts.url || "";
  const at = opts.at ?? 0;
  const response = stamp(new Response(bodyInit(status, body), { status, headers: new Headers(opts.headers) }), {
    url,
    at,
    via: opts.via,
    kind: opts.kind,
  });
  return { response, body, url, at };
}

export function dump(row: StoredHttp): {
  at: number;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    at: row.at,
    url: row.url,
    status: row.response.status,
    headers: headersRecord(row.response.headers),
    body: row.body,
  };
}

export const HTTP_TABLE = `
  CREATE TABLE IF NOT EXISTS http (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    url TEXT,
    status INTEGER,
    headers TEXT,
    body TEXT
  );
`;
