/**
 * Parse layer. The only place that interprets Mojang (or future) payloads.
 * Storage keeps Request/Response bytes — ship a new parser if they break the API.
 *
 * History (this repo, not the wiki):
 *   991e1e9  passthrough non-200 (never invent 404 from 5xx/429)  issues #28 #35 #40 #54
 *   9c905fa  miss is 204 OR 404
 */
import type { Classify, NameState, SessionProfile } from "./types";
import { looksLikeHtml, tryJson, asRecord, asString, asBool } from "./safe";
import { asUuid } from "./ids";
import { meta, type StoredHttp } from "./raw";
import { parseLimitHeaders, type LimitHeaders } from "./limit";

export const PARSER = "v1";

const MISSING_PHRASE =
  /couldn't find any profile|couldn't find any player|no such (profile|player|user)|not a valid uuid/i;

export function isAbsentStatus(status: number | null | undefined): boolean {
  return status === 204 || status === 404;
}

export function missingPhrase(body: string | null | undefined): boolean {
  if (!body) return false;
  const parsed = tryJson(body);
  const rec = asRecord(parsed);
  if (rec) {
    const msg = `${asString(rec.errorMessage) || ""} ${asString(rec.error) || ""} ${asString(rec.path) || ""}`;
    if (MISSING_PHRASE.test(msg)) return true;
    if (asString(rec.error) === "NOT_FOUND") return true;
  }
  return MISSING_PHRASE.test(body);
}

/** Interpret a stored/origin Response. Body is passed in so the Response can still be cloned elsewhere. */
export function classify(res: Response, body?: string | null): Classify {
  const status = res.status;
  const text = body ?? null;
  const contentType = res.headers.get("content-type");
  const url = meta(res, "url") || res.url || null;
  if (meta(res, "error") && (status === 502 || status === 0 || !status)) return "network";
  if (looksLikeHtml(text, contentType)) {
    if (status === 429) return "ratelimit";
    if (status === 403 || status === 503 || status === 502) return "blocked";
    return "garbage";
  }
  if (isAbsentStatus(status)) return "missing";
  if (status === 200 && url && /sessionserver\.mojang\.com/i.test(url) && !(text && text.trim())) return "missing";
  if (status >= 200 && status < 300 && missingPhrase(text)) return "missing";
  if (status === 200) {
    const parsed = tryJson(text);
    if (parsed && typeof parsed === "object") return "ok";
    if (text && text.trim() && !parsed) return "garbage";
    return "ok";
  }
  if (status === 400) return "invalid";
  if (status === 403) return "blocked";
  if (status === 429) return "ratelimit";
  if (status >= 500) return "upstream";
  if (status >= 400) return "upstream";
  return "garbage";
}

export function isTerminal(c: Classify): boolean {
  return c === "ok" || c === "missing" || c === "invalid";
}

export function shouldRotate(c: Classify): boolean {
  return c === "blocked" || c === "ratelimit" || c === "network" || c === "garbage" || c === "upstream" || c === "skipped";
}

export function clientSawMiss(classified: string | null | undefined, status: number | null | undefined): boolean {
  if (classified === "missing") return true;
  if (
    classified === "blocked" ||
    classified === "ratelimit" ||
    classified === "upstream" ||
    classified === "garbage" ||
    classified === "network" ||
    classified === "skipped"
  ) {
    return false;
  }
  return isAbsentStatus(status);
}

export function publicErrorStatus(classified: string | null | undefined, status: number | null | undefined): number {
  if (clientSawMiss(classified, status)) return 404;
  if (classified === "ratelimit" || classified === "blocked" || status === 403 || status === 429) return 429;
  if (classified === "invalid") return 400;
  const n = typeof status === "number" ? status : 0;
  if (n === 404 || n === 204 || n < 400) return 502;
  return n;
}

export function classifyArgs(status: number | null, body: string | null, contentType?: string | null, url?: string | null): Classify {
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  if (url) headers.set("x-archive-url", url);
  if (status == null) headers.set("x-archive-error", "network");
  const res = new Response(body ?? "", { status: status == null ? 502 : status, headers });
  return classify(res, body);
}

export interface Identity {
  id: string;
  name: string;
  legacy?: boolean;
  demo?: boolean;
}

/** Extract a name→uuid payload. Null if this Response is not a current identity document. */
export function identity(res: Response, body: string): Identity | null {
  if (classify(res, body) !== "ok") return null;
  const rec = asRecord(tryJson(body));
  if (!rec) return null;
  const id = asUuid(asString(rec.id) || "", false, "any");
  const name = asString(rec.name);
  if (!id || !name) return null;
  const out: Identity = { id, name };
  if (asBool(rec.legacy)) out.legacy = true;
  if (asBool(rec.demo)) out.demo = true;
  return out;
}

export function session(res: Response, body: string): SessionProfile | null {
  if (classify(res, body) !== "ok") return null;
  const rec = asRecord(tryJson(body));
  if (!rec || !asString(rec.name)) return null;
  return rec as SessionProfile;
}

export function limitOf(res: Response): LimitHeaders {
  return parseLimitHeaders(res.headers, Number(meta(res, "at")) || Date.now());
}

/** Replay stored HTTP with the current parser. A parser bump re-reads history as-is. */
export function foldName(name: string, rows: StoredHttp[]): NameState {
  const state: NameState = {
    name,
    uuid: null,
    lastStatus: null,
    firstSeenAt: rows[0]?.at ?? null,
    firstAliveAt: null,
    firstMissingAt: null,
    lastAliveAt: null,
    lastMissingAt: null,
    lastRefreshAt: null,
  };
  for (const row of rows) {
    const c = classify(row.response, row.body);
    if (!isTerminal(c)) continue;
    state.lastRefreshAt = row.at;
    state.lastStatus = row.response.status;
    const id = identity(row.response, row.body);
    if (c === "ok" && id) {
      if (!state.firstAliveAt) state.firstAliveAt = row.at;
      state.lastAliveAt = row.at;
      state.uuid = id.id;
    } else if (c === "missing") {
      if (!state.firstMissingAt) state.firstMissingAt = row.at;
      state.lastMissingAt = row.at;
    }
  }
  return state;
}
