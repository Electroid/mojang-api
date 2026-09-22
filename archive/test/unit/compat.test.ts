import { describe, expect, it } from "vitest";
import { toV1User, toV2User, toV4User, decodeTextures } from "../../src/compat";
import type { CompatInput } from "../../src/compat";
import { PIXEL_PNG_B64 } from "../../src/skins";

function input(over: Partial<CompatInput> = {}): CompatInput {
  const textures = btoa(
    JSON.stringify({
      timestamp: 1,
      profileId: "069a79f444e94726a5befca90e38aaf5",
      profileName: "Notch",
      textures: { SKIN: { url: "http://textures.minecraft.net/texture/abc" } },
    }),
  );
  return {
    uuid: "069a79f444e94726a5befca90e38aaf5",
    username: "Notch",
    history: [{ username: "Notch", changedAt: null }],
    profile: {
      id: "069a79f444e94726a5befca90e38aaf5",
      name: "Notch",
      properties: [{ name: "textures", value: textures, signature: "sig" }],
      profileActions: [],
    },
    skinB64: PIXEL_PNG_B64,
    capeB64: null,
    firstAliveAt: null,
    firstMissingAt: null,
    firstSeenAt: 1,
    createdAt: null,
    ...over,
  };
}

describe("compat JSON", () => {
  it("v2 includes grandfathered fields and omits false legacy/demo", () => {
    const v2 = toV2User(input());
    expect(v2.uuid).toBe("069a79f4-44e9-4726-a5be-fca90e38aaf5");
    expect(v2.username).toBe("Notch");
    expect(v2.created_at).toBeNull();
    expect(v2.legacy).toBeUndefined();
    expect(v2.demo).toBeUndefined();
    const textures = v2.textures as Record<string, unknown>;
    expect(textures.custom).toBe(true);
    expect(textures.slim).toBe(false);
    expect((textures.skin as { url: string }).url).toContain("textures.minecraft.net");
    expect(textures.raw).toBeTruthy();
    expect(Array.isArray(v2.username_history)).toBe(true);
  });

  it("v1 has cached_at and no raw", () => {
    const v1 = toV1User(input());
    expect(v1.cached_at).toMatch(/T/);
    expect((v1.textures as Record<string, unknown>).raw).toBeUndefined();
  });

  it("v4 adds archive timestamps", () => {
    const v4 = toV4User(input({ firstMissingAt: 100, firstAliveAt: 200 }));
    expect(v4.archive.created_at_estimated).toBe(new Date(200).toISOString().slice(0, 10));
    expect(v4.archive.first_missing_at).toBeTruthy();
  });

  it("missing SKIN still yields a skin url (default template)", () => {
    const v2 = toV2User(
      input({
        profile: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "NoSkin", properties: [] },
        skinB64: null,
        uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        username: "NoSkin",
      }),
    );
    const textures = v2.textures as Record<string, unknown>;
    expect(textures.custom).toBe(false);
    expect((textures.skin as { url: string }).url).toMatch(/SkinTemplates/);
    expect((textures.skin as { data: string }).data).toBeTruthy();
  });

  it("decodeTextures tolerates garbage properties", () => {
    expect(decodeTextures({ properties: "nope" as unknown as [] }).textures).toEqual({});
    expect(decodeTextures({ properties: [{ name: "textures", value: "!!!!" }] }).textures).toEqual({});
    expect(decodeTextures(null).textures).toEqual({});
  });
});
