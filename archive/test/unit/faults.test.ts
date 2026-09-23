import { describe, expect, it } from "vitest";
import { api, jsonOf } from "./call";
import { sim } from "./sim";

describe("fault tolerance", () => {
  it("403 HTML is rate-limit, never user-not-found (WEB-7591 / issue #80)", async () => {
    sim.quirks.html403 = true;
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).toBe(429);
    const body = await jsonOf(res);
    expect(body.error).toBe("Too Many Requests");
    expect(body.reason).not.toMatch(/No user/);
  });

  it("malformed Mojang JSON is not a 404", async () => {
    sim.quirks.malformed = true;
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).not.toBe(404);
    expect(res.status).toBeGreaterThanOrEqual(429);
  });

  it("204 missing name is still 404 to clients (9c905fa)", async () => {
    sim.quirks.name204 = true;
    const res = await api("/mojang/v2/user/NoSuchName123");
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error).toBe("Not Found");
    expect(body.reason).toMatch(/NoSuchName123/);
  });

  it("session 404 is the same client 404 as session 204", async () => {
    sim.quirks.session404 = true;
    const res = await api("/mojang/v2/user/00000000-0000-4000-0000-000000000000");
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error).toBe("Not Found");
  });

  it("Mojang 500 is not user-not-found (#28 / 991e1e9)", async () => {
    sim.quirks.upstream500 = true;
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(500);
    const body = await jsonOf(res);
    expect(body.reason).not.toMatch(/No user/);
  });

  it("HTML 404 WAF is not cached as missing (#40)", async () => {
    sim.quirks.html404 = true;
    const blocked = await api("/mojang/v2/user/Notch");
    expect(blocked.status).not.toBe(404);
    sim.quirks.html404 = false;
    const recovered = await api("/mojang/v2/user/Notch");
    expect(recovered.status).toBe(200);
    expect((await jsonOf(recovered)).username).toBe("Notch");
  });

  it("ignores extra future schema fields", async () => {
    sim.quirks.extra = true;
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.username).toBe("Notch");
    expect(body.unexpectedFutureField).toBeUndefined();
  });

  it("texture CDN 500 still returns a profile", async () => {
    sim.quirks.textureFail = true;
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.username).toBe("Notch");
    expect(body.textures.skin.url).toBeTruthy();
  });

  it("does not cache 429 as missing", async () => {
    sim.add({ name: "QuotaGuy", id: "cccccccccccccccccccccccccccccccc", skin: true });
    sim.quota = 0;
    const first = await api("/mojang/v2/user/QuotaGuy");
    expect(first.status).toBe(429);
    sim.quota = 10_000;
    sim.used = 0;
    const second = await api("/mojang/v2/user/QuotaGuy");
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).username).toBe("QuotaGuy");
  });

  it("missing session UUID is 404 (upstream 204)", async () => {
    const res = await api("/mojang/v2/user/00000000-0000-4000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("unknown methods 405, junk paths 404, never 500", async () => {
    expect((await api("/mojang/v2/user/Notch", { method: "POST" })).status).toBe(405);
    expect((await api("/nope")).status).toBe(404);
    expect((await api("/mojang/v9/user/Notch")).status).toBe(404);
  });
});
