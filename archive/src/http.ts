export function log(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  } catch {
    /* ignore */
  }
}

export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  let body = "{}";
  try {
    body = JSON.stringify(data, null, 2);
  } catch {
    body = JSON.stringify({ code: 500, error: "Internal Error", reason: "unserializable" });
    status = 500;
  }
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-max-age": "86400",
      ...extra,
    },
  });
}

export function text(data: string, status = 200, extra: HeadersInit = {}): Response {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-max-age": "86400",
      ...extra,
    },
  });
}

export function cors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}

export function v2Error(status: number, type: string, reason: string): Response {
  return json({ code: status, error: type, reason }, status);
}

/** Grandfathered v1: `{code} - {type} ({reason})` text/plain. */
export function v1Error(status: number, type: string, reason?: string): Response {
  const body = `${status} - ${type}${reason ? ` (${reason})` : ""}`;
  return text(body, status);
}

export function requestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-x`;
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
}
