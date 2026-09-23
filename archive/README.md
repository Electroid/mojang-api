# mojang-archive

Isolated Cloudflare Worker. **Does not use** `mojang_api_v1` / `v2` / `v3` KV or Durable Objects.

Cloudflare-only: raw `cloudflare:sockets` TLS plus colo-keyed Durable Objects for IP rotation. No Fly hop.

## Goal

A fault-tolerant Mojang profile archive that spends scarce Mojang rate-limit budget on **new** identities first (work-stealing), keeps forever-SQLite **HTTP Request/Response** bytes, and still speaks the grandfathered v1/v2 JSON.

## Layers

If Mojang breaks the JSON again, ship a new **parser**. Every name DO and UUID DO keeps an append-only **ledger** of the exact `Response` at that timestamp (status, headers, body). Public JSON is always folded from that ledger — never from a derived snapshot. Skin/cape CDN fetches and decoded texture payloads are the same kind of row (`x-archive-kind`: `lookup` | `session` | `uuid` | `decode` | `texture`).

| Layer | Module | Job |
| --- | --- | --- |
| Transport | `transport.ts`, `tcp.ts` | Dumb GET (fetch or raw TCP). `Request` in, origin `Response` out. |
| Store | `raw.ts`, `store.ts`, Cache API | Freeze/thaw that `Response` verbatim (binary as base64). L1 is per-colo `caches.default`. |
| Parse | `parse.ts` (`PARSER=v1`) | 204\|\|404 miss, identity, session, textures. `foldName` / `foldProfile` replay the ledger. |
| Policy | `fetch-client.ts`, `limit.ts`, `gate.ts` | Rotate colos on 429/403; AIMD from headers or implied req/s; work-stealing. |
| API | `compat.ts`, `index.ts` | Grandfathered v1/v2/v4 JSON. |

Colos are discovered from `request.cf.colo` as Cloudflare adds them. Egress DOs are `idFromName("colo:"+IATA)` with **no** locationHint, so the first request from a new colo pins a proxy there.

## Why a new worker

Live `mojang_api_v2` was 530 because it fetched `api.gamertag.dev`. After that proxy was removed, Cloudflare Worker `fetch()` to Mojang returned **403/429** (shared Worker egress IPs). [Electroid/mojang-api#61](https://github.com/Electroid/mojang-api/issues/61), [#85](https://github.com/Electroid/mojang-api/issues/85), [WEB-6431](https://mojira.dev/WEB-6431).

Durable Objects do **not** get unique IPs by themselves. A colo-keyed `ArchiveTcp` (`colo:{IATA}`) is created on first traffic from that colo (no IATA table). The gate discovers rate limits from origin headers (`x-minecraft-rate-limit-result`, `Retry-After`, `X-RateLimit-*`) or implied req/s between 429s.

## Work-stealing

Mojang’s IP bucket is the scarce resource. Refreshing Notch for the millionth time must not starve a first-seen name.

- **`new`**: never-seen name/uuid. May spend the **reserved** tokens. The client waits.
- **`missing`**: recent 404/204. Short negative TTL (60s). Cannot spend the reserve.
- **`refresh`**: already archived. Response is **stale immediately**; a background refresh runs only if the discovered token bucket still has room after reserving half for new lookups.

Per-source-IP (`ArchiveClient`): ≥10 req/min widens stale window; ≥30 req/min disables refresh entirely. New lookups still proceed.

Do **not** cache 403/429/5xx/HTML WAF pages as “player missing” ([#80](https://github.com/Electroid/mojang-api/issues/80), [#28](https://github.com/Electroid/mojang-api/issues/28), [#40](https://github.com/Electroid/mojang-api/issues/40), `991e1e9`, WEB-7591).

## Measured (2026-09-22), not wiki

From this VM (non-Cloudflare IP), `x-minecraft-rate-limit-result: UNDER_LIMIT`:

- `GET https://api.minecraftservices.com/minecraft/profile/lookup/name/{name}` **primary**
- `GET https://api.mojang.com/minecraft/profile/lookup/name/{name}` and `/users/profiles/minecraft/{name}` fallbacks
- UUID lookup dashed or not; sessionserver `?unsigned=false` (signature)

| Wiki / old code | Measured / this repo |
| --- | --- |
| Missing name 204 (wiki.vg snapshot) | Live **404** JSON `Couldn't find any profile with name …`. Old coffee after `9c905fa` treats **204 \|\| 404** as the same miss |
| `/user/profiles/{uuid}/names` | **404** `NOT_FOUND` (removed 2022-09-13) |
| `?at=` historical username | **Ignored** (WEB-3367). Notch `at=0` is still Notch |
| `status.mojang.com/check` | **NXDOMAIN** (removed 2021-10-08) |
| Session missing UUID | **204** empty (`src/mojang.coffee` `@throws {204}`); 404 is accepted too |
| MCS missing UUID | **404** |
| Bulk max 100 (old wiki.vg) | **10**; empty/11 → 400 `CONSTRAINT_VIOLATION` |
| CORS on Mojang | **none** (WEB-1587). Worker adds `*` |
| Skin URLs | **`http://textures.minecraft.net/...`**; HTTPS rewrite works |
| `legacy` / `demo` | omitted unless true |
| `profileActions` | present on sessionserver (`[]`) |
| Random 403 HTML from Azure WAF | WEB-7591 / WEB-8043 — **not** a missing player |
| Mojang 500 / 429 as our 404 | Bugs [#28](https://github.com/Electroid/mojang-api/issues/28) [#35](https://github.com/Electroid/mojang-api/issues/35) [#40](https://github.com/Electroid/mojang-api/issues/40) [#54](https://github.com/Electroid/mojang-api/issues/54); fixed by `991e1e9` passthrough |

`created_at` was never a Mojang field ([#16](https://github.com/Electroid/mojang-api/issues/16)); it was a binary search on dead `?at=`. This archive sets it **only** if it observed missing then later alive.

## Grandfathered v1/v2

Copied from `/workspace/src` + live bundles, not from the wiki:

- `GET /mojang/v2/user/{username\|uuid}` JSON (pretty, 2-space)
- `GET /mojang/v2/uuid/{username}` dashed UUID **text**
- `GET /mojang/v1/user/...` same core + `cached_at`, **no** `raw` / `created_at`
- v2 errors `{code,error,reason}`; v1 `{code} - {type} ({reason})` text
- Username `[0-9A-Za-z_]{1,16}` on v1/v2; v4 also allows hyphen ([#27](https://github.com/Electroid/mojang-api/issues/27))
- UUID **v4-only** on v1/v2 (old `util.coffee` regex); v4 accepts any 32-hex
- Missing = Mojang 204 **or** 404 → client 404 (`9c905fa`)
- Default Steve/Alex skin when `SKIN` is absent ([#26](https://github.com/Electroid/mojang-api/issues/26)), `uuidIsSlim` nibble XOR
- CORS on v2 (v1 historically had none; archive adds `*` anyway)
- **Dropped:** avatar SVG, KV bindings, dead `/names` + birthday + status, CF mirage/polish, Fly proxy

## Egress

Tried in order (`EGRESS_METHODS`, default `socket,fetch`):

1. `cloudflare:sockets` HTTP/1.1 from `ArchiveTcp` shards (Java UA, `Connection: close`, no CF fetch hop headers). 403/429/5xx **rotate** to the next colo shard; 204/404 **do not**.
2. `fetch()` last (tests / when sockets fail)

No third-party proxy. Failover across Mojang hosts is one logical query (one token).

## Tests

Cloudflare **Vitest plugin** (`@cloudflare/vitest-plugin`) + SQLite DOs + MSW (`@msw/cloudflare`) simulated Mojang:

```bash
cd archive
npm test          # unit/sim, no live Mojang
npm run test:e2e  # real Mojang via Miniflare fetch (this VM’s IP)
```

Simulated backend (`test/unit/sim.ts`) covers 403 HTML, HTML 404, 204 vs 404, Mojang 500, malformed JSON, extra fields, texture failures, quota, and work-stealing.

## Routes

Worker route `api.ashcon.app/mojang/v4*` plus `*.workers.dev`. Legacy v1/v2 workers stay on their routes.

- `GET /mojang/v2/user/{username|uuid}`
- `GET /mojang/v2/uuid/{username}`
- `GET /mojang/v1/user/{username|uuid}`
- `GET /mojang/v4/user/{username|uuid}` (adds `archive`)
- `GET /mojang/v4/history/{username|uuid}`
- `GET /mojang/v4/health`
- `GET /mojang/v4/debug/egress`
