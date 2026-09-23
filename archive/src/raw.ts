/**
 * Wire format for the dumb HTTP layer: standard Request / Response.
 * Extra fields live on headers named x-archive-*. Parsers must not require them.
 */

export const X = "x-archive-";

export function originRequest(url: string, from?: Request): Request {
  return new Request(url, {
    method: "GET",
    headers: {
      Accept: from?.headers.get("accept") || "application/json",
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

/** Persist a Response as HTTP status + header block + body. */
export async function freeze(res: Response): Promise<{ status: number; headers: string; body: string }> {
  const body = await res.clone().text();
  return { status: res.status, headers: encodeHeaders(res.headers), body };
}

/** Rehydrate a stored HTTP message. Invalid statuses become 502 with x-archive-error. */
export function thaw(status: number, headers: string, body: string): Response {
  const h = decodeHeaders(headers);
  const code = status >= 200 && status <= 599 ? status : 502;
  if (status < 200 || status > 599) h.set(X + "error", h.get(X + "error") || "bad-status");
  return new Response(body, { status: code, headers: h });
}

export type StoredHttp = { response: Response; body: string; url: string; at: number };

export function stored(
  status: number,
  body: string,
  opts: { url?: string; at?: number; headers?: HeadersInit; via?: string } = {},
): StoredHttp {
  const url = opts.url || "";
  const at = opts.at ?? 0;
  const response = stamp(new Response(body, { status, headers: new Headers(opts.headers) }), {
    url,
    at,
    via: opts.via,
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
