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

  it("204 missing name is still 404 to clients", async () => {
    sim.quirks.name204 = true;
    const res = await api("/mojang/v2/user/NoSuchName123");
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error).toBe("Not Found");
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
