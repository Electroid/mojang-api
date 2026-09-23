import type { Classify } from "./types";

/**
 * Discover origin rate limits. Nothing here is Mojang-specific besides
 * reading whatever headers showed up. Unknown starts slow (prior) and is
 * overwritten by headers or by implied req/s between 429s.
 */

export interface LimitHeaders {
  result?: string;
  retryAfterMs?: number;
  limit?: number;
  remaining?: number;
  resetMs?: number;
  cacheTtlMs?: number;
}

export interface LimitState {
  rate: number;
  cap: number;
  tokens: number;
  updated: number;
  windowOk: number;
  windowStart: number;
  coolUntil: number;
  lastHeader: string | null;
  source: "header" | "implied" | "prior";
  cacheTtlMs: number | null;
}

export function freshLimit(now: number): LimitState {
  return {
    rate: 1,
    cap: 2,
    tokens: 1,
    updated: now,
    windowOk: 0,
    windowStart: now,
    coolUntil: 0,
    lastHeader: null,
    source: "prior",
    cacheTtlMs: null,
  };
}

function headerMap(input: Headers | Record<string, string | undefined | null> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!input) return out;
  if (typeof (input as Headers).forEach === "function" && typeof (input as Headers).get === "function") {
    (input as Headers).forEach((v, k) => out.set(k.toLowerCase(), v));
    return out;
  }
  for (const [k, v] of Object.entries(input as Record<string, string | undefined | null>)) {
    if (v) out.set(k.toLowerCase(), v);
  }
  return out;
}

function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(String(v).split(";")[0].trim());
  return Number.isFinite(n) ? n : undefined;
}

function retryAfterMs(raw: string | undefined, now: number): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, 120_000);
  const at = Date.parse(s);
  if (Number.isFinite(at) && at > now) return Math.min(at - now, 120_000);
  return undefined;
}

function cacheTtlMs(cc: string | undefined): number | undefined {
  if (!cc) return undefined;
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  if (!m) return undefined;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec < 0) return undefined;
  return Math.min(sec * 1000, 3600_000);
}

/** IETF RateLimit / X-RateLimit / Retry-After / Mojang x-minecraft-rate-limit-result / Cache-Control. */
export function parseLimitHeaders(input: Headers | Record<string, string | undefined | null> | null | undefined, now = Date.now()): LimitHeaders {
  const h = headerMap(input);
  const out: LimitHeaders = {};
  const result = h.get("x-minecraft-rate-limit-result") || h.get("x-ratelimit-result");
  if (result) out.result = result.toUpperCase().replace(/\s+/g, "_");
  const retry = retryAfterMs(h.get("retry-after"), now);
  if (retry != null) out.retryAfterMs = retry;
  const limit = num(h.get("x-ratelimit-limit") || h.get("ratelimit-limit") || h.get("x-rate-limit-limit"));
  if (limit != null && limit > 0) out.limit = limit;
  const remaining = num(h.get("x-ratelimit-remaining") || h.get("ratelimit-remaining"));
  if (remaining != null && remaining >= 0) out.remaining = remaining;
  const reset = num(h.get("x-ratelimit-reset") || h.get("ratelimit-reset"));
  if (reset != null) {
    out.resetMs = reset > 1e12 ? reset : reset > 1e9 ? reset * 1000 : now + reset * 1000;
  }
  const ttl = cacheTtlMs(h.get("cache-control"));
  if (ttl != null) out.cacheTtlMs = ttl;
  return out;
}

function refill(state: LimitState, now: number): LimitState {
  if (state.coolUntil && now < state.coolUntil) {
    return state;
  }
  if (state.coolUntil && state.tokens < 1) {
    const cap = Math.max(2, state.cap);
    return { ...state, tokens: cap, cap, updated: now, coolUntil: 0 };
  }
  const elapsed = Math.max(0, (now - state.updated) / 1000);
  const tokens = Math.min(state.cap, state.tokens + elapsed * state.rate);
  return { ...state, tokens, updated: now };
}

function applyHeaderBudget(state: LimitState, headers: LimitHeaders, now: number): LimitState {
  let next = { ...state };
  if (headers.cacheTtlMs) next.cacheTtlMs = headers.cacheTtlMs;
  if (headers.result) next.lastHeader = headers.result;
  if (headers.limit && headers.limit > 0) {
    const periodSec = headers.resetMs && headers.resetMs > now ? (headers.resetMs - now) / 1000 : 1;
    const rate = headers.limit / Math.max(periodSec, 1);
    next.rate = Math.max(0.05, rate);
    next.cap = Math.max(1, headers.limit);
    next.source = "header";
    if (headers.remaining != null) next.tokens = Math.min(next.cap, headers.remaining);
  }
  return next;
}

export function observe(
  state: LimitState,
  ev: { at: number; classified: Classify | string; headers?: Headers | Record<string, string | undefined | null> | null },
): LimitState {
  const now = ev.at;
  let next = refill(state, now);
  const headers = parseLimitHeaders(ev.headers, now);
  next = applyHeaderBudget(next, headers, now);

  const over = headers.result === "OVER_LIMIT" || ev.classified === "ratelimit" || ev.classified === "blocked";
  const under = headers.result === "UNDER_LIMIT" || ev.classified === "ok" || ev.classified === "missing" || ev.classified === "invalid";

  if (over) {
    const elapsed = Math.max(0.2, (now - next.windowStart) / 1000);
    const implied = next.windowOk / elapsed;
    const cut = next.source === "header" ? next.rate * 0.5 : implied > 0 ? implied * 0.8 : next.rate * 0.5;
    next.rate = Math.max(0.05, cut);
    next.cap = Math.max(1, next.rate * 2);
    next.tokens = 0;
    next.coolUntil = now + (headers.retryAfterMs ?? Math.min(60_000, Math.max(400, 1000 / next.rate)));
    next.windowOk = 0;
    next.windowStart = now;
    if (!headers.limit) next.source = "implied";
    return next;
  }

  if (under) {
    next.windowOk += 1;
    if (now - next.windowStart > 30_000) {
      next.windowOk = 1;
      next.windowStart = now;
    }
    if (headers.result === "UNDER_LIMIT" && next.source !== "header") {
      next.rate = Math.min(50, next.rate + 0.05);
      next.cap = Math.max(next.cap, next.rate * 2);
      next.source = "implied";
    }
    next.coolUntil = 0;
  }
  return next;
}

export function cooling(state: LimitState, now: number): boolean {
  return state.coolUntil > now;
}

export function take(
  state: LimitState,
  now: number,
  priority: "new" | "missing" | "refresh" = "new",
): { ok: boolean; reason: string; state: LimitState } {
  let next = refill(state, now);
  if (cooling(next, now) && priority !== "new") {
    return { ok: false, reason: "cooling", state: next };
  }
  if (cooling(next, now) && next.tokens < 0.5) {
    return { ok: false, reason: "cooling", state: next };
  }
  const reserve = Math.max(0.5, next.cap * 0.5);
  const needReserve = priority === "refresh" || priority === "missing";
  if (needReserve && next.tokens < 1 + reserve) {
    return { ok: false, reason: "reserved_for_new", state: next };
  }
  if (next.tokens < 1) {
    return { ok: false, reason: "empty", state: next };
  }
  next = { ...next, tokens: next.tokens - 1 };
  return { ok: true, reason: "ok", state: next };
}
