import { describe, expect, it } from "vitest";
import { classify, isTerminal, shouldRotate, isAbsentStatus, clientSawMiss, missingPhrase, publicErrorStatus } from "../../src/absent";
import { parseMethods } from "../../src/egress";
import { planHops } from "../../src/fetch-client";

describe("absent classification (9c905fa + 991e1e9 + issues #28 #40 #54)", () => {
  it("204 empty and 404 JSON are the same miss", () => {
    expect(isAbsentStatus(204)).toBe(true);
    expect(isAbsentStatus(404)).toBe(true);
    expect(classify(204, "", null)).toBe("missing");
    expect(classify(404, '{"errorMessage":"Couldn\'t find any profile with name x"}', "application/json")).toBe("missing");
    expect(isTerminal("missing")).toBe(true);
    expect(shouldRotate("missing")).toBe(false);
  });

  it("empty 200 on sessionserver is a miss (schema drift)", () => {
    expect(classify(200, "", "application/json", "https://sessionserver.mojang.com/session/minecraft/profile/abc")).toBe("missing");
    expect(classify(200, "{}", "application/json", "https://sessionserver.mojang.com/session/minecraft/profile/abc")).toBe("ok");
  });

  it("Mojang 500 is upstream, never missing (#28)", () => {
    const c = classify(
      500,
      '{"error":"Internal Server Error","errorMessage":"The server encountered an unexpected condition"}',
      "application/json",
    );
    expect(c).toBe("upstream");
    expect(isTerminal(c)).toBe(false);
    expect(clientSawMiss(c, 500)).toBe(false);
  });

  it("429 JSON is ratelimit, not 404 (#40)", () => {
    const c = classify(429, '{"error":"TooManyRequestsException"}', "application/json");
    expect(c).toBe("ratelimit");
    expect(shouldRotate(c)).toBe(true);
    expect(clientSawMiss(c, 429)).toBe(false);
  });

  it("403 HTML WAF is blocked (#80 / WEB-7591)", () => {
    const c = classify(403, "<html>Azure Application Gateway</html>", "text/html");
    expect(c).toBe("blocked");
    expect(clientSawMiss(c, 403)).toBe(false);
  });

  it("HTML 404 is garbage, not a Mojang miss", () => {
    const c = classify(404, "<!DOCTYPE html><html><head></head></html>", "text/html");
    expect(c).toBe("garbage");
    expect(clientSawMiss(c, 404)).toBe(false);
    expect(clientSawMiss("missing", 404)).toBe(true);
  });

  it("NOT_FOUND JSON phrase is a miss even on odd 2xx", () => {
    expect(missingPhrase('{"error":"NOT_FOUND","errorMessage":"Not Found"}')).toBe(true);
    expect(classify(200, '{"error":"NOT_FOUND","errorMessage":"Not Found"}', "application/json")).toBe("missing");
  });

  it("400 invalid is terminal and not rotated", () => {
    expect(classify(400, '{"error":"CONSTRAINT_VIOLATION"}', "application/json")).toBe("invalid");
    expect(isTerminal("invalid")).toBe(true);
    expect(shouldRotate("invalid")).toBe(false);
  });

  it("publicErrorStatus never turns infra into client 404", () => {
    expect(publicErrorStatus("missing", 204)).toBe(404);
    expect(publicErrorStatus("missing", 404)).toBe(404);
    expect(publicErrorStatus("upstream", 500)).toBe(500);
    expect(publicErrorStatus("garbage", 404)).toBe(502);
    expect(publicErrorStatus("blocked", 403)).toBe(429);
    expect(publicErrorStatus("ratelimit", 429)).toBe(429);
  });
});

describe("discovered colo hops", () => {
  it("plans from observed colos, prefer first, fetch last", () => {
    const hops = planHops({ methods: ["socket", "fetch"], colos: ["QPG", "SJC"], prefer: "QPG", shards: 1, maxHops: 6 });
    expect(hops[0].colo).toBe("QPG");
    expect(hops[0].doKey).toBe("colo:QPG");
    expect(hops.some((h) => h.colo === "SJC")).toBe(true);
    expect(hops[hops.length - 1]).toEqual({ kind: "fetch", colo: "local", key: "fetch:local" });
  });
});

describe("parseMethods", () => {
  it("drops the old Fly proxy token and defaults to socket,fetch", () => {
    expect(parseMethods("socket,proxy,fetch")).toEqual(["socket", "fetch"]);
    expect(parseMethods(undefined)).toEqual(["socket", "fetch"]);
    expect(parseMethods("fetch")).toEqual(["fetch"]);
  });
});
