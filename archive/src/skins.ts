import { asUuid, uuidIsSlim, STEVE_UUID, ALEX_UUID } from "./ids";

export { STEVE_UUID, ALEX_UUID };

export const URL_STEVE = "http://assets.mojang.com/SkinTemplates/steve.png";
export const URL_ALEX = "http://assets.mojang.com/SkinTemplates/alex.png";

/** 1×1 PNG fallback so missing/default skins never crash the JSON shape (issue #26). */
export const PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function defaultSkin(uuid: string): { url: string; slim: boolean } {
  const slim = uuidIsSlim(asUuid(uuid, false, "any") || uuid);
  return { url: slim ? URL_ALEX : URL_STEVE, slim };
}

export function httpsRewrite(url: string): string {
  if (url.startsWith("http://")) return "https://" + url.slice("http://".length);
  return url;
}
