import type { SessionProfile, TexturePayload } from "./types";
import { asUuid, dayString } from "./ids";
import { asArray, asBool, asRecord, asString, tryJson } from "./safe";
import { PIXEL_PNG_B64, defaultSkin } from "./skins";

export interface CompatInput {
  uuid: string;
  username: string;
  history: Array<{ username: string; changedAt: number | null }>;
  profile: SessionProfile | null;
  skinB64: string | null;
  capeB64: string | null;
  firstAliveAt: number | null;
  firstMissingAt: number | null;
  firstSeenAt: number | null;
  createdAt: number | null;
}

export function decodeTextures(profile: SessionProfile | null): {
  textures: NonNullable<TexturePayload["textures"]>;
  raw?: { value: string; signature?: string };
  slim: boolean;
} {
  try {
    const props = asArray(profile?.properties);
    const prop = props.find((p) => asString(asRecord(p)?.name) === "textures");
    const rec = asRecord(prop);
    const value = asString(rec?.value);
    if (!value) return { textures: {}, slim: false };
    const decoded = tryJson(atobSafe(value));
    const parsed = asRecord(decoded) as TexturePayload | null;
    const textures = (parsed?.textures || {}) as NonNullable<TexturePayload["textures"]>;
    const slim = asString(asRecord(asRecord(textures.SKIN)?.metadata)?.model) === "slim";
    const signature = asString(rec?.signature) || undefined;
    return { textures, raw: { value, signature }, slim };
  } catch {
    return { textures: {}, slim: false };
  }
}

function atobSafe(value: string): string {
  try {
    return atob(value);
  } catch {
    return "";
  }
}

/** Only when this archive saw a 404 (or 204) and later a 200 for that identity. */
export function estimatedCreatedAt(firstMissingAt: number | null, firstAliveAt: number | null): number | null {
  if (firstMissingAt && firstAliveAt && firstAliveAt >= firstMissingAt) return firstAliveAt;
  return null;
}

export function toV2User(input: CompatInput) {
  const { textures, raw, slim: slimMeta } = decodeTextures(input.profile);
  const skinUrl = asString(asRecord(textures.SKIN)?.url);
  const capeUrl = asString(asRecord(textures.CAPE)?.url);
  const fallback = defaultSkin(input.uuid);
  const custom = Boolean(skinUrl);
  const slim = slimMeta || (!custom && fallback.slim);
  const created = estimatedCreatedAt(input.firstMissingAt, input.firstAliveAt) ?? input.createdAt;
  const history = Array.isArray(input.history) && input.history.length
    ? input.history
    : [{ username: input.username, changedAt: null }];

  const out: Record<string, unknown> = {
    uuid: asUuid(input.uuid, true, "any") || input.uuid,
    username: input.username,
    username_history: history.map((h) => {
      const row: { username: string; changed_at?: string } = { username: h.username };
      if (h.changedAt) {
        try {
          row.changed_at = new Date(h.changedAt).toISOString();
        } catch {
          /* omit */
        }
      }
      return row;
    }),
    textures: {
      custom,
      slim,
      skin: {
        url: skinUrl || fallback.url,
        data: input.skinB64 || PIXEL_PNG_B64,
      },
      ...(capeUrl
        ? { cape: { url: capeUrl, data: input.capeB64 || undefined } }
        : {}),
      ...(raw?.value ? { raw: { value: raw.value, signature: raw.signature } } : {}),
    },
    created_at: dayString(created),
  };
  if (asBool(input.profile?.legacy)) out.legacy = true;
  if (asBool(input.profile?.demo)) out.demo = true;
  return out;
}

export function toV1User(input: CompatInput) {
  const v2 = toV2User(input);
  const textures = { ...(v2.textures as Record<string, unknown>) };
  delete textures.raw;
  return {
    uuid: v2.uuid,
    username: v2.username,
    username_history: v2.username_history,
    textures,
    cached_at: new Date().toISOString(),
  };
}

export function toV4User(input: CompatInput) {
  const v2 = toV2User(input);
  const actions = asArray(input.profile?.profileActions);
  return {
    ...v2,
    archive: {
      first_seen_at: input.firstSeenAt ? iso(input.firstSeenAt) : null,
      first_alive_at: input.firstAliveAt ? iso(input.firstAliveAt) : null,
      first_missing_at: input.firstMissingAt ? iso(input.firstMissingAt) : null,
      created_at_estimated: dayString(estimatedCreatedAt(input.firstMissingAt, input.firstAliveAt)),
      note: "created_at is only set when this archive observed the name/uuid missing and later become alive.",
      profile_actions: actions.length ? actions : [],
    },
  };
}

function iso(ms: number): string | null {
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}
