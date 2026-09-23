import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { freshLimit, observe, parseLimitHeaders, take } from "../../src/limit";
import { classify, foldName, identity } from "../../src/parse";
import { dump, freeze, stored, thaw } from "../../src/raw";
import { planHops, runHops, type Attempt } from "../../src/fetch-client";
import { ArchiveTcp } from "../../src/tcp";

describe("limit discovery", () => {
  it("reads Mojang and IETF headers", () => {
    const h = parseLimitHeaders({
      "x-minecraft-rate-limit-result": "UNDER_LIMIT",
      "cache-control": "max-age=300",
      "retry-after": "2",
      "x-ratelimit-limit": "10",
      "x-ratelimit-remaining": "4",
    });
    expect(h.result).toBe("UNDER_LIMIT");
    expect(h.cacheTtlMs).toBe(300_000);
    expect(h.retryAfterMs).toBe(2000);
    expect(h.limit).toBe(10);
    expect(h.remaining).toBe(4);
  });

  it("implies rate from ok window then 429", () => {
    let s = freshLimit(1000);
    for (let i = 0; i < 5; i++) {
      s = observe(s, { at: 1000 + i * 200, classified: "ok", headers: { "x-minecraft-rate-limit-result": "UNDER_LIMIT" } });
    }
    s = observe(s, { at: 2200, classified: "ratelimit", headers: { "x-minecraft-rate-limit-result": "OVER_LIMIT" } });
    expect(s.source).toBe("implied");
    expect(s.rate).toBeGreaterThan(0);
    expect(s.coolUntil).toBeGreaterThan(2200);
    expect(take(s, 2200, "refresh").ok).toBe(false);
  });
});

describe("parse layer vs stored Response", () => {
  it("replays 204 then 200 with a later parser fold", () => {
    const rows = [
      stored(204, "", { at: 1, url: "https://api.mojang.com/users/profiles/minecraft/foo" }),
      stored(200, JSON.stringify({ id: "069a79f444e94726a5befca90e38aaf5", name: "Notch" }), {
        at: 2,
        headers: { "content-type": "application/json" },
      }),
    ];
    expect(classify(rows[0].response, rows[0].body)).toBe("missing");
    expect(identity(rows[1].response, rows[1].body)?.name).toBe("Notch");
    const folded = foldName("foo", rows);
    expect(folded.firstMissingAt).toBe(1);
    expect(folded.firstAliveAt).toBe(2);
    expect(folded.uuid).toBe("069a79f444e94726a5befca90e38aaf5");
  });

  it("parses a plain Response without x-archive-* headers", () => {
    const body = JSON.stringify({ id: "069a79f444e94726a5befca90e38aaf5", name: "Notch" });
    const res = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    expect(classify(res, body)).toBe("ok");
    expect(identity(res, body)?.name).toBe("Notch");
  });

  it("freezes and thaws a Response including x-archive-* meta", async () => {
    const row = stored(404, '{"error":"NOT_FOUND"}', {
      url: "https://api.minecraftservices.com/minecraft/profile/lookup/name/nope",
      at: 9,
      via: "fetch:local",
      headers: { "content-type": "application/json", "x-minecraft-rate-limit-result": "UNDER_LIMIT" },
    });
    const frozen = await freeze(row.response);
    const thawed = thaw(frozen.status, frozen.headers, frozen.body);
    expect(thawed.status).toBe(404);
    expect(thawed.headers.get("x-archive-via")).toBe("fetch:local");
    expect(thawed.headers.get("x-minecraft-rate-limit-result")).toBe("UNDER_LIMIT");
    expect(classify(thawed, frozen.body)).toBe("missing");
    expect(dump({ ...row, response: thawed }).headers["x-archive-url"]).toContain("lookup/name/nope");
  });
});

describe("fetch client policy", () => {
  it("skips a colo after 429 and uses the next", async () => {
    const hops = planHops({ methods: ["socket", "fetch"], colos: ["AAA", "BBB"], prefer: "AAA" });
    const { last, attempts } = await runHops(hops, async (hop): Promise<Attempt> => {
      if (hop.colo === "AAA") {
        return { method: "socket", url: "u", ok: false, status: 429, ms: 1, classified: "ratelimit", via: hop.key };
      }
      return { method: hop.kind, url: "u", ok: true, status: 200, ms: 1, classified: "ok", via: hop.key };
    });
    expect(attempts[0].via).toContain("AAA");
    expect(last?.classified).toBe("ok");
    expect(last?.via).toContain("BBB");
  });
});

describe("ArchiveTcp Request/Response", () => {
  it("takes an origin Request and returns the origin Response", async () => {
    const stub = env.ARCHIVE_TCP.get(env.ARCHIVE_TCP.idFromName("colo:TEST"));
    await runInDurableObject(stub, async (inst: ArchiveTcp) => {
      const req = new Request("https://api.mojang.com/users/profiles/minecraft/Notch", {
        headers: {
          Accept: "application/json",
          "x-archive-mode": "fetch",
          "x-archive-via": "test",
        },
      });
      const res = await inst.fetch(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-archive-via")).toBe("test");
      expect(res.headers.get("x-minecraft-rate-limit-result")).toBe("UNDER_LIMIT");
      const body = (await res.json()) as { name?: string };
      expect(body.name).toBe("Notch");
    });
  });
});
