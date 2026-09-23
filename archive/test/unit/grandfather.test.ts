import { describe, expect, it } from "vitest";
import { api, jsonOf } from "./call";

describe("grandfathered v1/v2 surface", () => {
  it("OPTIONS is CORS 204", async () => {
    const res = await api("/mojang/v2/user/Notch", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
  });

  it("v2 malformed username is JSON 400", async () => {
    const res = await api("/mojang/v2/user/bad-name");
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.code).toBe(400);
    expect(body.error).toBe("Bad Request");
    expect(body.reason).toMatch(/Invalid format for the name/);
  });

  it("v1 malformed username is text 400", async () => {
    const res = await api("/mojang/v1/user/bad-name");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toMatch(/^400 - Bad Request \(malformed username/);
  });

  it("v2 malformed UUID (non-v4) is 400", async () => {
    const res = await api("/mojang/v2/user/069a79f4-44e9-3726-a5be-fca90e38aaf5");
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.reason).toMatch(/Invalid format for the name|UUID/i);
  });

  it("v2 uuid endpoint returns dashed text", async () => {
    const res = await api("/mojang/v2/uuid/Notch");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("069a79f4-44e9-4726-a5be-fca90e38aaf5");
  });

  it("v2 user JSON shape", async () => {
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.uuid).toBe("069a79f4-44e9-4726-a5be-fca90e38aaf5");
    expect(body.username).toBe("Notch");
    expect(body.username_history[0].username).toBe("Notch");
    expect(body.textures.custom).toBe(true);
    expect(body.textures.skin.url).toBeTruthy();
    expect(body.textures.skin.data).toBeTruthy();
    expect(body.textures.raw.value).toBeTruthy();
    expect(body.created_at).toBeNull();
    expect(body.cached_at).toBeUndefined();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("v1 user has cached_at and no raw", async () => {
    const res = await api("/mojang/v1/user/Notch");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.cached_at).toMatch(/T/);
    expect(body.textures.raw).toBeUndefined();
    expect(body.created_at).toBeUndefined();
  });

  it("missing name is 404 not 204", async () => {
    const res = await api("/mojang/v2/user/NoSuchName123");
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error).toBe("Not Found");
    expect(body.reason).toMatch(/NoSuchName123/);
  });

  it("unknown route 404 JSON", async () => {
    const res = await api("/mojang/v2/nope/Notch");
    expect(res.status).toBe(404);
  });
});
