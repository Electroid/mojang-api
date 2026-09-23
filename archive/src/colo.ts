/**
 * Global traffic lands on many colos. Keep the topology dumb:
 *
 *   L1  caches.default          already per-colo. Absorbs Notch etc. with zero DO hops.
 *   L2  ArchiveName / Profile   one DO per identity. First get() (no hint) spawns near
 *                               that colo, so the archive lives where the name was first
 *                               seen. Other colos RPC to it — the DO *is* the queue.
 *   L3  FetchClient             Mojang via colo-keyed egress DOs. Colos are discovered
 *                               from request.cf.colo as CF adds them; no IATA table.
 *
 * Do not open a Queue per colo. Cloudflare Queues are account-global; N colos × refresh
 * would stampede the same Mojang IP budget. Identity DOs already serialize origin work.
 */

export function requestColo(request: Request): string | null {
  const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo;
  if (!colo || typeof colo !== "string") return null;
  const id = colo.trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(id) ? id : null;
}

export function coloDoKey(colo: string): string {
  return `colo:${colo.trim().toUpperCase()}`;
}

function cacheKey(request: Request): Request {
  try {
    const path = new URL(request.url).pathname;
    return new Request(`https://l1.mojang-archive${path}`, { method: "GET" });
  } catch {
    return new Request("https://l1.mojang-archive/invalid", { method: "GET" });
  }
}

/** L1: colo-local Cache API. 200 and 404 only — never 429/5xx (#28/#40). */
export async function l1Match(request: Request): Promise<Response | null> {
  try {
    const hit = await caches.default.match(cacheKey(request));
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    headers.set("x-archive-tier", "l1");
    return new Response(hit.body, { status: hit.status, headers });
  } catch {
    return null;
  }
}

export async function l1Put(request: Request, response: Response, ttlMs: number): Promise<void> {
  if (response.status !== 200 && response.status !== 404) return;
  const ttlSec = Math.max(1, Math.min(3600, Math.ceil(ttlMs / 1000)));
  try {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", `public, max-age=${ttlSec}`);
    headers.set("x-archive-tier", "l1");
    await caches.default.put(cacheKey(request), new Response(response.body, { status: response.status, headers }));
  } catch {
    /* cache API missing or quota — L2 still works */
  }
}

export function withTier(response: Response, tier: "l1" | "l2" | "l3", colo?: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("x-archive-tier", tier);
  if (colo) headers.set("x-archive-colo", colo);
  return new Response(response.body, { status: response.status, headers });
}
