import { describe, expect, it } from "vitest";
import { asUsername, asUuid, uuidIsSlim, STEVE_UUID, ALEX_UUID } from "../../src/ids";
import { classify, isTerminal } from "../../src/egress";
import { estimatedCreatedAt } from "../../src/compat";
import { tryJson, looksLikeHtml } from "../../src/safe";

describe("ids", () => {
  it("accepts dashed and undashed UUID v4", () => {
    expect(asUuid("069a79f4-44e9-4726-a5be-fca90e38aaf5", false, "v4")).toBe("069a79f444e94726a5befca90e38aaf5");
    expect(asUuid("069a79f444e94726a5befca90e38aaf5", true, "v4")).toBe("069a79f4-44e9-4726-a5be-fca90e38aaf5");
  });

  it("grandfathered v4-only mode rejects non-v4 UUIDs", () => {
    expect(asUuid("069a79f4-44e9-3726-a5be-fca90e38aaf5", false, "v4")).toBeNull();
    expect(asUuid("069a79f4-44e9-3726-a5be-fca90e38aaf5", false, "any")).toBe("069a79f444e93726a5befca90e38aaf5");
  });

  it("usernames: strict vs hyphen-loose", () => {
    expect(asUsername("Notch", "strict")).toBe("Notch");
    expect(asUsername("bad-name", "strict")).toBeNull();
    expect(asUsername("bad-name", "loose")).toBe("bad-name");
    expect(asUsername("thisnameistoolongg", "strict")).toBeNull();
  });

  it("uuidIsSlim is even/odd nibble XOR (lowercase-safe)", () => {
    expect(typeof uuidIsSlim(STEVE_UUID)).toBe("boolean");
    expect(uuidIsSlim(STEVE_UUID.toUpperCase())).toBe(uuidIsSlim(STEVE_UUID));
    expect(uuidIsSlim(ALEX_UUID)).toBe(uuidIsSlim(ALEX_UUID.toUpperCase()));
  });
});

describe("classify", () => {
  it("does not treat 403 HTML as missing", () => {
    const c = classify(403, "<html>Azure Application Gateway</html>", "text/html");
    expect(c).toBe("blocked");
    expect(isTerminal(c)).toBe(false);
  });

  it("treats 204 and 404 as missing (terminal)", () => {
    expect(classify(204, "", null)).toBe("missing");
    expect(classify(404, '{"errorMessage":"nope"}', "application/json")).toBe("missing");
    expect(isTerminal("missing")).toBe(true);
  });

  it("treats malformed 200 JSON as garbage", () => {
    expect(classify(200, "{not json", "application/json")).toBe("garbage");
    expect(isTerminal("garbage")).toBe(false);
  });

  it("429 is ratelimit, not 404", () => {
    expect(classify(429, '{"error":"TooManyRequestsException"}', "application/json")).toBe("ratelimit");
  });
});

describe("safe", () => {
  it("tryJson is permissive", () => {
    expect(tryJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryJson("prefix {\"a\":1}")).toEqual({ a: 1 });
    expect(tryJson("nope")).toBeNull();
    expect(looksLikeHtml("<!DOCTYPE html>", "text/html")).toBe(true);
  });
});

describe("created_at estimate", () => {
  it("only when missing then alive", () => {
    expect(estimatedCreatedAt(100, 200)).toBe(200);
    expect(estimatedCreatedAt(null, 200)).toBeNull();
    expect(estimatedCreatedAt(300, 200)).toBeNull();
  });
});
