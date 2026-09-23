import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { api, jsonOf } from "./call";
import { sim } from "./sim";
import { ArchiveName } from "../../src/name";
import { ArchiveProfile } from "../../src/profile";
import { ArchiveEgress } from "../../src/gate";

async function ageNotch(): Promise<void> {
  const name = env.ARCHIVE_NAMES.get(env.ARCHIVE_NAMES.idFromName("notch"));
  await runInDurableObject(name, async (_inst: ArchiveName, state) => {
    const rows = [...state.storage.sql.exec(`SELECT v FROM kv WHERE k = 'state'`)];
    const row = rows[0] as { v: string } | undefined;
    if (!row) return;
    const s = JSON.parse(row.v);
    s.lastRefreshAt = 1;
    state.storage.sql.exec(
      `INSERT INTO kv (k,v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(s),
    );
  });
  const profile = env.ARCHIVE_PROFILES.get(env.ARCHIVE_PROFILES.idFromName("069a79f444e94726a5befca90e38aaf5"));
  await runInDurableObject(profile, async (_inst: ArchiveProfile, state) => {
    try {
      state.storage.sql.exec(`UPDATE snapshots SET at = 1`);
    } catch {
      /* ignore */
    }
  });
}

async function setTokens(tokens: number): Promise<void> {
  const gate = env.ARCHIVE_EGRESS.get(env.ARCHIVE_EGRESS.idFromName("gate"));
  await runInDurableObject(gate, async (_inst: ArchiveEgress, state) => {
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO kv (k,v) VALUES ('limit', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify({
        rate: 1,
        cap: 8,
        tokens,
        updated: now,
        windowOk: 0,
        windowStart: now,
        coolUntil: 0,
        lastHeader: null,
        source: "prior",
        cacheTtlMs: null,
      }),
    );
  });
}

describe("work-stealing rate-limit budget", () => {
  it("known identities yield to new lookups when only reserved tokens remain", async () => {
    const primed = await api("/mojang/v2/user/Notch");
    expect(primed.status).toBe(200);

    await ageNotch();
    await setTokens(4);
    sim.used = 0;
    sim.calls = [];

    const stale = await api("/mojang/v2/user/Notch");
    expect(stale.status).toBe(200);
    expect((await jsonOf(stale)).username).toBe("Notch");
    const afterStale = sim.apiCalls().length;
    expect(afterStale).toBe(0);

    const fresh = await api("/mojang/v2/user/jeb_");
    expect(fresh.status).toBe(200);
    expect((await jsonOf(fresh)).username).toBe("jeb_");
    expect(sim.apiCalls().length).toBeGreaterThan(afterStale);
  });

  it("new names still spend the reserve when Mojang quota is tight", async () => {
    await setTokens(4);
    sim.quota = 10_000;
    sim.used = 0;
    const res = await api("/mojang/v2/user/Alex");
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).username).toBe("Alex");
  });
});
