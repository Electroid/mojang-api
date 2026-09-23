import { describe, expect, it } from "vitest";
import { api, jsonOf } from "./call";
import { sim } from "./sim";

describe("lookup via simulated Mojang", () => {
  it("resolves case-insensitive names to canonical casing", async () => {
    const res = await api("/mojang/v2/user/notch");
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).username).toBe("Notch");
  });

  it("accepts dashed and undashed UUID", async () => {
    const a = await api("/mojang/v2/user/069a79f444e94726a5befca90e38aaf5");
    const b = await api("/mojang/v2/user/069a79f4-44e9-4726-a5be-fca90e38aaf5");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await jsonOf(a)).username).toBe("Notch");
    expect((await jsonOf(b)).username).toBe("Notch");
  });

  it("v4 includes archive block and profile_actions", async () => {
    const res = await api("/mojang/v4/user/jeb_");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.textures.cape.url).toBeTruthy();
    expect(body.archive.first_seen_at).toBeTruthy();
    expect(Array.isArray(body.archive.profile_actions)).toBe(true);
  });

  it("health talks to the gate DO", async () => {
    const res = await api("/mojang/v4/health");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.isolated).toBe(true);
    expect(body.worker).toBe("mojang-archive");
  });

  it("serves cached Notch without extra Mojang name lookups", async () => {
    await api("/mojang/v2/user/Notch");
    const before = sim.apiCalls().length;
    const res = await api("/mojang/v2/user/Notch");
    expect(res.status).toBe(200);
    expect(sim.apiCalls().length).toBe(before);
  });

  it("history endpoint records a ledger of exact lookup Responses", async () => {
    await api("/mojang/v4/user/Notch");
    const res = await api("/mojang/v4/history/Notch");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.state.uuid).toBe("069a79f444e94726a5befca90e38aaf5");
    expect(body.observations.length).toBeGreaterThan(0);
    expect(body.ledger.length).toBeGreaterThan(0);
    expect(body.ledger[0].headers).toBeTruthy();
    expect(typeof body.ledger[0].body).toBe("string");
    expect(body.ledger[0].status).toBe(200);
  });

  it("uuid ledger stores session, decoded textures, and skin HTTP", async () => {
    await api("/mojang/v4/user/jeb_");
    const res = await api("/mojang/v4/history/853c80ef3c3749fdaa49938b674adae6");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const kinds = (body.kinds as Array<{ kind: string }>).map((k) => k.kind);
    expect(kinds).toContain("session");
    expect(kinds).toContain("decode");
    expect(kinds).toContain("texture");
    const session = (body.ledger as Array<{ kind?: string; headers: Record<string, string>; body: string }>).find(
      (r) => r.headers["x-archive-kind"] === "session" || /sessionserver/.test(r.headers["x-archive-url"] || ""),
    );
    expect(session?.body).toMatch(/jeb_/i);
    expect(session?.headers["content-type"]).toMatch(/json/);
  });

  it("v4 hyphen username is forwarded to Mojang (issue #27)", async () => {
    const res = await api("/mojang/v4/user/bad-name");
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.reason).toMatch(/bad-name/);
  });

  it("Alex is slim", async () => {
    const res = await api("/mojang/v2/user/Alex");
    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body.textures.slim).toBe(true);
  });

  it("missing SKIN object does not crash (issue #26)", async () => {
    sim.add({
      name: "Bare",
      id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      skin: false,
      noProperties: true,
    });
    const res = await api("/mojang/v2/user/Bare");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.textures.custom).toBe(false);
    expect(body.textures.skin.url).toMatch(/SkinTemplates/);
  });
});
