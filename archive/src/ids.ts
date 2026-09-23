/** Grandfathered v1/v2 validation plus a looser v4 archive parser. */

const USERNAME_STRICT = /^[0-9A-Za-z_]{1,16}$/;
const USERNAME_LOOSE = /^[0-9A-Za-z_\-]{1,16}$/;
const UUID_V4 = /^([0-9a-f]{8})-?([0-9a-f]{4})-?(4[0-9a-f]{3})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;
const UUID_ANY = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

export function asUsername(value: string, mode: "strict" | "loose" = "strict"): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (mode === "strict") return USERNAME_STRICT.test(v) ? v : null;
  return USERNAME_LOOSE.test(v) ? v : null;
}

export function asUuid(value: string, dashed = false, mode: "v4" | "any" = "any"): string | null {
  if (typeof value !== "string") return null;
  const match = (mode === "v4" ? UUID_V4 : UUID_ANY).exec(value.trim());
  if (!match) return null;
  const raw = match.slice(1).join("").toLowerCase();
  if (!dashed) return raw;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function hashIp(ip: string): string {
  let h = 2166136261;
  const s = String(ip || "unknown");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function dayString(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Same nibble XOR as src/mojang.coffee uuidIsSlim, but hex is lowercased first (old code broke on uppercase). */
export function uuidIsSlim(id: string): boolean {
  const hex = (asUuid(id, false, "any") || "").toLowerCase();
  if (hex.length < 32) return false;
  const nibble = (i: number) => {
    const c = hex.charCodeAt(i);
    if (c >= 97) return c - 87;
    return c - 48;
  };
  const sum = nibble(7) ^ nibble(15) ^ nibble(23) ^ nibble(31);
  return sum % 2 !== 0;
}

export const STEVE_UUID = "8667ba71b85a4004af54457a9734eed7";
export const ALEX_UUID = "ec561538f3fd461daff5086b22154bce";
