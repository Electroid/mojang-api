import { describe, expect, it } from "vitest";
import { api, jsonOf } from "../unit/call";

/**
 * Real Mojang, real sockets/fetch from this isolate.
 * Miniflare uses the VM IP (not Cloudflare Worker egress), which live probes showed is UNDER_LIMIT.
 */
describe("e2e live Mojang", () => {
  it("Notch v2 user from real Mojang", async () => {
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.uuid).toBe("069a79f4-44e9-4726-a5be-fca90e38aaf5");
    expect(body.username).toBe("Notch");
    expect(body.textures.skin.url).toMatch(/textures\.minecraft\.net/);
    expect(body.textures.raw.value).toBeTruthy();
    expect(body.created_at === null || typeof body.created_at === "string").toBe(true);
  });

  it("missing name is 404 JSON (live is 404, not wiki-vg 204)", async () => {
    const res = await api("/mojang/v2/user/NoSuchName123");
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error).toBe("Not Found");
  });

  it("uuid text endpoint", async () => {
    const res = await api("/mojang/v2/uuid/jeb_");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("853c80ef-3c37-49fd-aa49-938b674adae6");
  });

  it("v4 health", async () => {
    const res = await api("/mojang/v4/health");
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ok).toBe(true);
  });

  it("unsigned=false signature is present on live Notch", async () => {
    const res = await api("/mojang/v2/user/Notch");
    const body = await jsonOf(res);
    expect(body.textures.raw.signature).toBeTruthy();
  });
});
