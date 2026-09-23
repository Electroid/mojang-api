import type { EgressMethod, EgressResult, Env } from "./types";
import { isTerminal } from "./absent";
import { multiGet, parseMethods, publicResult } from "./fetch-client";

export { classify, isTerminal, shouldRotate } from "./absent";
export { parseMethods, planHops, runHops, fetchDirect, publicResult } from "./fetch-client";

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

type EnvLike = Pick<Env, "EGRESS_METHODS"> & Partial<Pick<Env, "ARCHIVE_TCP" | "TCP_SHARDS" | "ARCHIVE_EGRESS">>;

export async function egressGet(
  url: string,
  env: EnvLike,
  methodsOrOpts?: EgressMethod[] | { methods?: EgressMethod[]; prefer?: string | null },
): Promise<EgressResult> {
  const opts = Array.isArray(methodsOrOpts) ? { methods: methodsOrOpts } : methodsOrOpts || {};
  return multiGet(url, env, opts);
}

/** Try several equivalent Mojang URLs; first terminal answer wins. Failover is not extra rate-limit work. */
export async function egressFirst(
  urls: string[],
  env: EnvLike,
  opts: { prefer?: string | null } = {},
): Promise<EgressResult> {
  const attempts: EgressResult["attempts"] = [];
  let last: EgressResult | null = null;
  for (const url of urls) {
    const r = await egressGet(url, env, opts);
    attempts.push(...r.attempts);
    last = { ...r, attempts };
    if (isTerminal(r.classified)) return last;
  }
  return last || { ok: false, status: 502, body: null, json: null, method: "none", attempts, classified: "network" };
}

export async function experimentAll(env: EnvLike): Promise<unknown> {
  const targets = [
    "https://api.minecraftservices.com/minecraft/profile/lookup/name/Notch",
    "https://api.mojang.com/minecraft/profile/lookup/name/Notch",
    "https://api.mojang.com/users/profiles/minecraft/Notch",
    "https://api.minecraftservices.com/minecraft/profile/lookup/069a79f444e94726a5befca90e38aaf5",
    "https://sessionserver.mojang.com/session/minecraft/profile/069a79f444e94726a5befca90e38aaf5?unsigned=false",
    "https://api.mojang.com/user/profiles/069a79f444e94726a5befca90e38aaf5/names",
    "https://api.minecraftservices.com/minecraft/profile/lookup/name/NoSuchName123",
  ];
  const results = [];
  for (const url of targets) {
    results.push(publicResult(await egressGet(url, env)));
  }
  return { from: "cloudflare-worker", methods: parseMethods(env.EGRESS_METHODS), results };
}
