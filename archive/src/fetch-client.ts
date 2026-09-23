import type { Classify, EgressAttempt, EgressMethod, EgressResult, Env } from "./types";
import { classify, isTerminal, shouldRotate } from "./parse";
import { coloDoKey } from "./colo";
import { cacheTtlMs, headersRecord, meta, originRequest } from "./raw";
import { proxyFetch } from "./transport";
import { log } from "./http";
import { envInt, never, tryJson } from "./safe";

export interface Hop {
  kind: EgressMethod;
  colo: string;
  key: string;
  doKey?: string;
}

export type Attempt = EgressAttempt & { response?: Response; body?: string };

export function planHops(opts: {
  methods: EgressMethod[];
  colos?: string[];
  prefer?: string | null;
  shards?: number;
  maxHops?: number;
}): Hop[] {
  const shards = Math.max(1, Math.min(opts.shards ?? 1, 8));
  const maxHops = Math.max(1, Math.min(opts.maxHops ?? 6, 12));
  const seen = new Set<string>();
  const colos: string[] = [];
  const add = (c?: string | null) => {
    const id = (c || "").trim().toUpperCase();
    if (!id || id === "LOCAL" || seen.has(id)) return;
    seen.add(id);
    colos.push(id);
  };
  add(opts.prefer);
  for (const c of opts.colos || []) add(c);

  const remote: Hop[] = [];
  const local: Hop[] = [];
  for (const method of opts.methods) {
    if (method === "fetch") {
      local.push({ kind: "fetch", colo: "local", key: "fetch:local" });
      continue;
    }
    if (method !== "socket" && method !== "do-fetch") continue;
    for (const colo of colos) {
      for (let i = 0; i < shards; i++) {
        remote.push({
          kind: method,
          colo,
          key: `${method}:${colo}:${i}`,
          doKey: i === 0 ? coloDoKey(colo) : `${coloDoKey(colo)}:${i}`,
        });
      }
    }
  }
  const keep = Math.max(0, maxHops - local.length);
  return [...remote.slice(0, keep), ...local].slice(0, maxHops);
}

export function coolAfter(classified: Classify, hop: Hop, cooled: Set<string>): void {
  if (classified === "ratelimit" || classified === "blocked") cooled.add(hop.colo);
  else if (classified === "network" || classified === "garbage" || classified === "skipped" || classified === "upstream") {
    cooled.add(hop.key);
  }
}

export function pickHop(hops: Hop[], cooled: Set<string>): Hop | undefined {
  return hops.find((h) => !cooled.has(h.colo) && !cooled.has(h.key));
}

export async function runHops(
  hops: Hop[],
  exec: (hop: Hop) => Promise<Attempt>,
): Promise<{ last: Attempt | null; attempts: Attempt[] }> {
  const cooled = new Set<string>();
  const attempts: Attempt[] = [];
  let last: Attempt | null = null;
  const remaining = [...hops];
  while (remaining.length) {
    const hop = pickHop(remaining, cooled);
    if (!hop) break;
    remaining.splice(remaining.indexOf(hop), 1);
    const attempt = await exec(hop);
    attempt.via = hop.key;
    attempts.push(attempt);
    last = attempt;
    const c = (attempt.classified as Classify) || "network";
    if (isTerminal(c)) return { last, attempts };
    if (!shouldRotate(c) && c !== "skipped") return { last, attempts };
    coolAfter(c, hop, cooled);
  }
  return { last, attempts };
}

async function fromResponse(res: Response, method: EgressMethod): Promise<Attempt> {
  const body = await res.clone().text();
  const classified = classify(res, body);
  return {
    method,
    url: meta(res, "url") || res.url,
    via: meta(res, "via") || method,
    ok: isTerminal(classified),
    status: res.status,
    ms: Number(meta(res, "ms")) || 0,
    error: meta(res, "error") || undefined,
    localAddress: meta(res, "local-address"),
    remoteAddress: meta(res, "remote-address"),
    bodyPreview: body.slice(0, 180),
    classified,
    response: res,
    body,
  };
}

export function toResult(a: Attempt, attempts: Attempt[]): EgressResult {
  const res = a.response;
  const classified = (a.classified as Classify) || (res ? classify(res, a.body) : "network");
  const body = a.body ?? null;
  const emptyMiss = classified === "missing" && (a.status === 204 || !(body && body.trim()));
  return {
    ok: isTerminal(classified),
    status: a.status || 0,
    body,
    json: emptyMiss ? null : tryJson(body),
    method: a.method,
    via: a.via,
    attempts,
    localAddress: a.localAddress,
    classified,
    response: res,
  };
}

/** JSON-safe view for debug endpoints. Drops the live Response. */
export function publicResult(r: EgressResult): Record<string, unknown> {
  const { response, attempts, ...rest } = r;
  return {
    ...rest,
    headers: response ? headersRecord(response.headers) : undefined,
    attempts: attempts.map((a) => {
      const { response: _res, body: _body, ...plain } = a as Attempt;
      return plain;
    }),
  };
}

type EnvLike = Pick<Env, "EGRESS_METHODS"> & Partial<Pick<Env, "ARCHIVE_TCP" | "TCP_SHARDS" | "ARCHIVE_EGRESS">>;

function tcpStub(env: EnvLike, hop: Hop): DurableObjectStub | null {
  if (!env.ARCHIVE_TCP || !hop.doKey) return null;
  return env.ARCHIVE_TCP.get(env.ARCHIVE_TCP.idFromName(hop.doKey));
}

async function execHop(url: string, hop: Hop, env: EnvLike): Promise<Attempt> {
  if (hop.kind === "fetch") {
    return fromResponse(await proxyFetch(originRequest(url), hop.key), "fetch");
  }
  const stub = tcpStub(env, hop);
  if (!stub) {
    return { method: hop.kind, url, ok: false, status: null, ms: 0, error: "no-ARCHIVE_TCP", classified: "network" };
  }
  return never(
    async () => {
      const origin = originRequest(url);
      const headers = new Headers(origin.headers);
      headers.set("x-archive-mode", hop.kind === "do-fetch" ? "fetch" : "socket");
      headers.set("x-archive-via", hop.key);
      const res = await stub.fetch(new Request(origin, { headers }));
      return fromResponse(res, hop.kind);
    },
    { method: hop.kind, url, ok: false, status: null, ms: 0, error: "tcp-do-failed", classified: "network" },
  );
}

export async function listColos(env: EnvLike): Promise<string[]> {
  if (!env.ARCHIVE_EGRESS) return [];
  return never(async () => {
    const stub = env.ARCHIVE_EGRESS.get(env.ARCHIVE_EGRESS.idFromName("gate"));
    const res = await stub.fetch("https://gate/colos");
    const json = (await res.json()) as { colos?: string[] };
    return Array.isArray(json.colos) ? json.colos : [];
  }, []);
}

export async function multiGet(
  url: string,
  env: EnvLike,
  opts: { methods?: EgressMethod[]; prefer?: string | null; colos?: string[] } = {},
): Promise<EgressResult> {
  const methods = opts.methods?.length ? opts.methods : parseMethods(env.EGRESS_METHODS);
  const colos = opts.colos ?? (await listColos(env));
  const hops = planHops({ methods, colos, prefer: opts.prefer, shards: envInt(env.TCP_SHARDS, 1) });
  const { last, attempts } = await runHops(hops, (hop) => execHop(url, hop, env));
  if (last) {
    log("egress", { method: last.method, status: last.status, classified: last.classified, via: last.via, tries: attempts.length });
    return toResult(last, attempts);
  }
  return { ok: false, status: 502, body: null, json: null, method: "none", attempts, classified: "network" };
}

export function parseMethods(raw: string | undefined): EgressMethod[] {
  const allowed: EgressMethod[] = ["socket", "do-fetch", "fetch"];
  const list = (raw || "socket,fetch")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is EgressMethod => (allowed as string[]).includes(s));
  return list.length ? list : ["fetch"];
}

export async function fetchDirect(url: string, via = "fetch"): Promise<Response> {
  return proxyFetch(originRequest(url), via);
}

export { cacheTtlMs, originRequest };
