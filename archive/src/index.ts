import { ArchiveName } from "./name";
import { ArchiveProfile } from "./profile";
import { ArchiveEgress } from "./gate";
import { ArchiveClient } from "./client";
import { ArchiveTcp } from "./tcp";
import type { Env, SessionProfile } from "./types";
import { asUsername, asUuid, hashIp } from "./ids";
import { clientIp as readIp, cors, json, log, requestId, text, v1Error, v2Error } from "./http";
import { toV1User, toV2User, toV4User } from "./compat";
import { experimentAll } from "./egress";
import { clientSawMiss, publicErrorStatus } from "./absent";
import { asNumber, asRecord, asString, envInt, never } from "./safe";
import { l1Match, l1Put, requestColo, withTier } from "./colo";
import { seeColo } from "./gate";

export { ArchiveName, ArchiveProfile, ArchiveEgress, ArchiveClient, ArchiveTcp };

type Version = "v1" | "v2" | "v4";

function parts(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

async function stubJson(stub: DurableObjectStub, req: string, init?: RequestInit): Promise<unknown> {
  return never(async () => {
    const res = await stub.fetch(req, init);
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      return { error: body, status: res.status };
    }
  }, { error: "stub failed" });
}

async function resolveName(env: Env, name: string, ip: string, colo?: string | null) {
  const stub = env.ARCHIVE_NAMES.get(env.ARCHIVE_NAMES.idFromName(name.toLowerCase()));
  return stubJson(stub, "https://name/resolve", { method: "POST", body: JSON.stringify({ name, ip, colo }) });
}

async function loadProfile(env: Env, uuid: string, ip: string, colo?: string | null) {
  const stub = env.ARCHIVE_PROFILES.get(env.ARCHIVE_PROFILES.idFromName(uuid));
  return stubJson(stub, "https://profile/load", { method: "POST", body: JSON.stringify({ uuid, ip, colo }) });
}

function err(version: Version, status: number, type: string, reason: string): Response {
  return version === "v1" ? v1Error(status, type, reason) : v2Error(status, type, reason);
}

function classifiedOf(value: unknown): string | null {
  const rec = asRecord(value);
  return asString(rec?.classified) || asString(asRecord(rec?.egress)?.classified);
}

function lastStatusOf(value: unknown): number {
  const rec = asRecord(value);
  const state = asRecord(rec?.state);
  const egress = asRecord(rec?.egress);
  return asNumber(state?.lastStatus) || asNumber(egress?.status) || asNumber(rec?.status) || 0;
}

function infraError(version: Version, status: number, classified: string | null): Response | null {
  if (classified === "ratelimit" || classified === "blocked" || status === 403 || status === 429) {
    return err(version, 429, "Too Many Requests", "Mojang API rate limited");
  }
  return null;
}

async function userPayload(env: Env, id: string, ip: string, version: Version, colo?: string | null): Promise<Response> {
  const uuidMode = version === "v4" ? "any" : "v4";
  const nameMode = version === "v4" ? "loose" : "strict";
  let uuid = asUuid(id, false, uuidMode);
  let firstMissingAt: number | null = null;
  let firstAliveAt: number | null = null;
  let firstSeenAt: number | null = null;

  if (!uuid) {
    const name = asUsername(id, nameMode);
    if (!name) {
      return version === "v1"
        ? v1Error(400, "Bad Request", `malformed username '${id}'`)
        : v2Error(400, "Bad Request", `Invalid format for the name '${id}'`);
    }
    const resolved = asRecord(await resolveName(env, name, ip, colo));
    const state = asRecord(resolved?.state);
    firstMissingAt = asNumber(state?.firstMissingAt) ?? asNumber(state?.lastMissingAt);
    firstAliveAt = asNumber(state?.firstAliveAt);
    firstSeenAt = asNumber(state?.firstSeenAt);
    const status = lastStatusOf(resolved);
    const classified = classifiedOf(resolved) || asString(asRecord(resolved?.egress)?.classified);
    uuid = asUuid(asString(state?.uuid) || "", false, "any");
    if (!uuid) {
      const miss = clientSawMiss(classified, status);
      const infra = infraError(version, status, classified);
      if (infra && !miss) return infra;
      if (miss) {
        return err(version, 404, "Not Found", `No user with the name '${name}' was found`);
      }
      if (infra) return infra;
      return err(version, publicErrorStatus(classified, status), "Bad Gateway", `Failed to fetch user with the name '${name}' from Mojang`);
    }
  }

  const profile = asRecord(await loadProfile(env, uuid, ip, colo));
  firstMissingAt = firstMissingAt ?? asNumber(profile?.firstMissingAt) ?? asNumber(profile?.lastMissingAt);
  firstAliveAt = firstAliveAt ?? asNumber(profile?.firstAliveAt);
  firstSeenAt = firstSeenAt ?? asNumber(profile?.firstSeenAt);
  const pStatus = asNumber(profile?.status) || 0;
  const pClass = asString(profile?.classified);
  const username = asString(profile?.username);
  const session = profile?.profile as SessionProfile | null;

  if (!session || !username) {
    const miss = clientSawMiss(pClass, pStatus);
    const infra = infraError(version, pStatus, pClass);
    if (infra && !miss) return infra;
    if (miss) {
      return err(version, 404, "Not Found", `No user with the UUID '${uuid}' was found`);
    }
    if (infra) return infra;
    return err(version, publicErrorStatus(pClass, pStatus), "Bad Gateway", `Failed to fetch user with the UUID '${uuid}' from Mojang`);
  }

  const input = {
    uuid,
    username,
    history: Array.isArray(profile?.history) ? (profile!.history as Array<{ username: string; changedAt: number | null }>) : [{ username, changedAt: null }],
    profile: session,
    skinB64: asString(profile?.skinB64),
    capeB64: asString(profile?.capeB64),
    firstAliveAt,
    firstMissingAt,
    firstSeenAt,
    createdAt: asNumber(profile?.createdAt),
  };
  if (version === "v1") return json(toV1User(input));
  if (version === "v4") return json(toV4User(input));
  return json(toV2User(input));
}

async function uuidPayload(env: Env, id: string, ip: string, version: Version, colo?: string | null): Promise<Response> {
  const nameMode = version === "v4" ? "loose" : "strict";
  const name = asUsername(id, nameMode);
  if (!name) {
    return version === "v1"
      ? v1Error(400, "Bad Request", `malformed username '${id}'`)
      : v2Error(400, "Bad Request", `Invalid format for the name '${id}'`);
  }
  const resolved = asRecord(await resolveName(env, name, ip, colo));
  const state = asRecord(resolved?.state);
  const uuid = asUuid(asString(state?.uuid) || "", true, "any");
  const status = lastStatusOf(resolved);
  const classified = classifiedOf(resolved) || asString(asRecord(resolved?.egress)?.classified);
  if (!uuid) {
    const miss = clientSawMiss(classified, status);
    const infra = infraError(version, status, classified);
    if (infra && !miss) return infra;
    if (miss) {
      return err(version, 404, "Not Found", `No user with the name '${name}' was found`);
    }
    if (infra) return infra;
    return err(version, publicErrorStatus(classified, status), "Bad Gateway", `Failed to fetch user with the name '${name}' from Mojang`);
  }
  return text(uuid);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const rid = requestId();
    const ip = readIp(request);
    const colo = requestColo(request);
    if (colo) ctx?.waitUntil(seeColo(env, colo));
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return v2Error(400, "Bad Request", "Invalid URL");
    }
    log("request", { rid, method: request.method, path: url.pathname, ipHash: hashIp(ip) });

    try {
      if (request.method === "OPTIONS") return cors();
      if (request.method !== "GET" && request.method !== "HEAD") {
        return v2Error(405, "Method Not Allowed", "GET only");
      }

      const p = parts(request.url);
      if (p[0] !== "mojang") return v2Error(404, "Not Found", "Unknown route");
      const version = p[1];
      const method = p[2];
      const arg = p[3];

      if (version === "v4" && method === "health") {
        const stats = await never(
          () => env.ARCHIVE_EGRESS.get(env.ARCHIVE_EGRESS.idFromName("gate")).fetch("https://gate/stats").then((r) => r.json()),
          { error: "gate unavailable" },
        );
        return json({ ok: true, worker: "mojang-archive", isolated: true, gate: stats });
      }
      if (version === "v4" && method === "debug" && p[3] === "egress") {
        return json(await experimentAll(env));
      }
      if (version === "v4" && method === "history" && arg) {
        const name = asUsername(arg, "loose");
        const uuid = asUuid(arg, false, "any");
        if (name) {
          const stub = env.ARCHIVE_NAMES.get(env.ARCHIVE_NAMES.idFromName(name.toLowerCase()));
          return json(await stubJson(stub, "https://name/history"));
        }
        if (uuid) {
          const stub = env.ARCHIVE_PROFILES.get(env.ARCHIVE_PROFILES.idFromName(uuid));
          return json(await stubJson(stub, "https://profile/snapshots"));
        }
        return v2Error(400, "Bad Request", "Need username or uuid");
      }

      if ((version === "v1" || version === "v2" || version === "v4") && (method === "user" || method === "uuid") && arg) {
        const hit = await l1Match(request);
        if (hit) return withTier(hit, "l1", colo);
        const t0 = Date.now();
        const res =
          method === "uuid"
            ? await uuidPayload(env, arg, ip, version, colo)
            : await userPayload(env, arg, ip, version, colo);
        log("response", { rid, path: url.pathname, status: res.status, ms: Date.now() - t0 });
        const out = withTier(res, "l2", colo);
        const ttl = out.status === 200 ? envInt(env.FRESH_MS, 300_000) : envInt(env.NEGATIVE_MS, 60_000);
        if (out.status === 200 || out.status === 404) ctx?.waitUntil(l1Put(request, out.clone(), ttl));
        if (request.method === "HEAD") return new Response(null, { status: out.status, headers: out.headers });
        return out;
      }

      return v2Error(404, "Not Found", "Unknown route");
    } catch (err) {
      log("error", { rid, error: err instanceof Error ? err.stack || err.message : String(err) });
      return v2Error(500, "Internal Error", err instanceof Error ? err.message : String(err));
    }
  },
};
