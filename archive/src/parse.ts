/**
 * Parse layer. The only place that interprets Mojang (or future) payloads.
 * Storage keeps Request/Response bytes — ship a new parser if they break the API.
 *
 * History (this repo, not the wiki):
 *   991e1e9  passthrough non-200 (never invent 404 from 5xx/429)  issues #28 #35 #40 #54
 *   9c905fa  miss is 204 OR 404
 */
import type { Classify, NameState, ProfileFold, SessionProfile, TexturePayload } from "./types";
import { looksLikeHtml, tryJson, asRecord, asString, asBool, asArray } from "./safe";
import { asUuid } from "./ids";
import { kindOf, meta, bodyInit, type StoredHttp } from "./raw";
import { parseLimitHeaders, type LimitHeaders } from "./limit";
import { httpsRewrite } from "./skins";

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
  const res = new Response(bodyInit(status == null ? 502 : status, body), { status: status == null ? 502 : status, headers });
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

export function decodeTextures(profile: SessionProfile | null): {
  textures: NonNullable<TexturePayload["textures"]>;
  decoded: Record<string, unknown> | null;
  raw?: { value: string; signature?: string };
  slim: boolean;
} {
  try {
    const props = asArray(profile?.properties);
    const prop = props.find((p) => asString(asRecord(p)?.name) === "textures");
    const rec = asRecord(prop);
    const value = asString(rec?.value);
    if (!value) return { textures: {}, decoded: null, slim: false };
    const decoded = asRecord(tryJson(atobSafe(value)));
    const parsed = decoded as TexturePayload | null;
    const textures = (parsed?.textures || {}) as NonNullable<TexturePayload["textures"]>;
    const slim = asString(asRecord(asRecord(textures.SKIN)?.metadata)?.model) === "slim";
    const signature = asString(rec?.signature) || undefined;
    return { textures, decoded, raw: { value, signature }, slim };
  } catch {
    return { textures: {}, decoded: null, slim: false };
  }
}

function atobSafe(value: string): string {
  try {
    return atob(value);
  } catch {
    return "";
  }
}

export function textureUrls(profile: SessionProfile | null): { skin?: string; cape?: string } {
  const { textures } = decodeTextures(profile);
  const skin = asString(asRecord(textures.SKIN)?.url) || undefined;
  const cape = asString(asRecord(textures.CAPE)?.url) || undefined;
  return { skin, cape };
}

export function sameTextureUrl(a: string, b: string): boolean {
  if (!a || !b) return false;
  return httpsRewrite(a) === httpsRewrite(b);
}

export function decodedTexturesResponse(profile: SessionProfile, at: number, uuid: string): Response | null {
  const { decoded, raw } = decodeTextures(profile);
  if (!decoded || !raw?.value) return null;
  return stampDecode(
    new Response(JSON.stringify(decoded), { status: 200, headers: { "content-type": "application/json" } }),
    at,
    uuid,
  );
}

function stampDecode(res: Response, at: number, uuid: string): Response {
  const headers = new Headers(res.headers);
  headers.set("x-archive-kind", "decode");
  headers.set("x-archive-via", "decode");
  headers.set("x-archive-at", String(at));
  headers.set("x-archive-url", `x-archive://decode/textures/${uuid}`);
  return new Response(res.body, { status: res.status, headers });
}

function latestTextureB64(rows: StoredHttp[], url: string | undefined): string | null {
  if (!url) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (kindOf(row) !== "texture") continue;
    if (row.response.status !== 200 || !row.body) continue;
    const got = row.url || meta(row.response, "url") || "";
    if (!sameTextureUrl(got, url)) continue;
    if (row.response.headers.get("x-archive-body") === "base64") return row.body;
    try {
      return btoa(row.body);
    } catch {
      return row.body;
    }
  }
  return null;
}

export function hasTexture(rows: StoredHttp[], url: string | undefined): boolean {
  return latestTextureB64(rows, url) != null;
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
    const kind = kindOf(row);
    if (kind === "texture" || kind === "decode" || kind === "session") continue;
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

/** Replay a UUID's ledger: session + lookup + decoded textures + skin/cape fetches. */
export function foldProfile(uuid: string, rows: StoredHttp[]): ProfileFold {
  const out: ProfileFold = {
    username: null,
    profile: null,
    skinB64: null,
    capeB64: null,
    history: [],
    firstSeenAt: rows[0]?.at ?? null,
    firstAliveAt: null,
    firstMissingAt: null,
    lastAliveAt: null,
    lastMissingAt: null,
    lastRefreshAt: null,
    lastStatus: null,
    classified: null,
  };
  let decoded: Record<string, unknown> | null = null;
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === "texture") continue;
    if (kind === "decode") {
      const rec = asRecord(tryJson(row.body));
      if (rec && row.response.status === 200) decoded = rec;
      continue;
    }
    const c = classify(row.response, row.body);
    if (!isTerminal(c)) continue;
    out.lastRefreshAt = row.at;
    out.lastStatus = row.response.status;
    out.classified = c;
    if (c === "ok") {
      if (!out.firstAliveAt) out.firstAliveAt = row.at;
      out.lastAliveAt = row.at;
      if (kind === "session") {
        const sess = session(row.response, row.body);
        if (sess) {
          out.profile = sess;
          const username = asString(sess.name);
          if (username) {
            out.username = username;
            const last = out.history[out.history.length - 1];
            if (!last || last.username !== username) {
              out.history.push({ username, changedAt: last ? row.at : null });
            }
          }
        }
      } else {
        const id = identity(row.response, row.body);
        if (id && !out.username) out.username = id.name;
      }
    } else if (c === "missing") {
      if (!out.firstMissingAt) out.firstMissingAt = row.at;
      out.lastMissingAt = row.at;
    }
  }
  const urls = out.profile
    ? textureUrls(out.profile)
    : {
        skin: asString(asRecord(asRecord(decoded?.textures)?.SKIN)?.url) || undefined,
        cape: asString(asRecord(asRecord(decoded?.textures)?.CAPE)?.url) || undefined,
      };
  out.skinB64 = latestTextureB64(rows, urls.skin);
  out.capeB64 = latestTextureB64(rows, urls.cape);
  if (out.profile && !out.username) out.username = asString(out.profile.name);
  return out;
}
