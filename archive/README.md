# mojang-archive

Isolated Cloudflare Worker. **Does not use** `mojang_api_v1` / `v2` / `v3` KV or Durable Objects.

## Goal

A fault-tolerant Mojang profile archive that spends scarce Mojang rate-limit budget on **new** identities first (work-stealing), keeps forever-SQLite snapshots, and still speaks the grandfathered v1/v2 JSON.

## Why a new worker

Live `mojang_api_v2` was 530 because it fetched `api.gamertag.dev`. After that proxy was removed, Cloudflare Worker `fetch()` to Mojang returned **403/429** (shared Worker egress IPs). [Electroid/mojang-api#61](https://github.com/Electroid/mojang-api/issues/61), [#85](https://github.com/Electroid/mojang-api/issues/85), [WEB-6431](https://mojira.dev/WEB-6431).

Durable Objects do **not** get unique IPs. The gate only meters tokens; Name/Profile DOs do the I/O in parallel.

## Work-stealing

Mojang’s IP bucket is the scarce resource. Refreshing Notch for the millionth time must not starve a first-seen name.

- **`new`**: never-seen name/uuid. May spend the **reserved** tokens. The client waits.
- **`missing`**: recent 404/204. Short negative TTL (60s). Cannot spend the reserve.
- **`refresh`**: already archived. Response is **stale immediately**; a background refresh runs only if tokens remain above `TOKEN_RESERVE` (default 4).

Per-source-IP (`ArchiveClient`): ≥10 req/min widens stale window; ≥30 req/min disables refresh entirely. New lookups still proceed.

Do **not** cache 403/429/5xx/HTML WAF pages as “player missing” ([#80](https://github.com/Electroid/mojang-api/issues/80), [#28](https://github.com/Electroid/mojang-api/issues/28), WEB-7591).

## Measured (2026-09-22), not wiki

From this VM (non-Cloudflare IP), `x-minecraft-rate-limit-result: UNDER_LIMIT`:

- `GET https://api.minecraftservices.com/minecraft/profile/lookup/name/{name}` **primary**
- `GET https://api.mojang.com/minecraft/profile/lookup/name/{name}` and `/users/profiles/minecraft/{name}` fallbacks
- UUID lookup dashed or not; sessionserver `?unsigned=false` (signature)
- Fly hop `falling-leaf-8926.fly.dev/?url=` still 200

| Wiki / old code | Measured |
| --- | --- |
| Missing name 204 (wiki.vg snapshot) | **404** JSON `Couldn't find any profile with name …` |
| `/user/profiles/{uuid}/names` | **404** `NOT_FOUND` (removed 2022-09-13) |
| `?at=` historical username | **Ignored** (WEB-3367). Notch `at=0` is still Notch |
| `status.mojang.com/check` | **NXDOMAIN** (removed 2021-10-08) |
| Session missing UUID | **204** empty |
| MCS missing UUID | **404** |
| Bulk max 100 (old wiki.vg) | **10**; empty/11 → 400 `CONSTRAINT_VIOLATION` |
| CORS on Mojang | **none** (WEB-1587). Worker adds `*` |
| Skin URLs | **`http://textures.minecraft.net/...`**; HTTPS rewrite works |
| `legacy` / `demo` | omitted unless true |
| `profileActions` | present on sessionserver (`[]`) |
| Random 403 HTML from Azure WAF | WEB-7591 / WEB-8043 — **not** a missing player |

`created_at` was never a Mojang field ([#16](https://github.com/Electroid/mojang-api/issues/16)); it was a binary search on dead `?at=`. This archive sets it **only** if it observed missing then later alive.

## Grandfathered v1/v2

Copied from `/workspace/src` + live bundles, not from the wiki:

- `GET /mojang/v2/user/{username\|uuid}` JSON (pretty, 2-space)
- `GET /mojang/v2/uuid/{username}` dashed UUID **text**
- `GET /mojang/v1/user/...` same core + `cached_at`, **no** `raw` / `created_at`
- v2 errors `{code,error,reason}`; v1 `{code} - {type} ({reason})` text
- Username `[0-9A-Za-z_]{1,16}` on v1/v2; v4 also allows hyphen ([#27](https://github.com/Electroid/mojang-api/issues/27))
- UUID **v4-only** on v1/v2 (old `util.coffee` regex); v4 accepts any 32-hex
- Missing = Mojang 204 **or** 404 → client 404
- Default Steve/Alex skin when `SKIN` is absent ([#26](https://github.com/Electroid/mojang-api/issues/26)), `uuidIsSlim` nibble XOR
- CORS on v2 (v1 historically had none; archive adds `*` anyway)
- **Dropped:** avatar SVG, KV bindings, dead `/names` + birthday + status, CF mirage/polish

## Egress

Tried in order (skip with `EGRESS_METHODS` in tests):

1. `cloudflare:sockets` HTTP/1.1 (chunked-aware, 403/429 are **not** terminal)
2. `EGRESS_PROXIES` (Fly hop)
3. `fetch()` last

Failover across Mojang hosts is one logical query (one token).

## Tests

Cloudflare **Vitest plugin** (`@cloudflare/vitest-plugin`) + SQLite DOs + MSW (`@msw/cloudflare`) simulated Mojang:

```bash
cd archive
npm test          # unit/sim, no live Mojang
npm run test:e2e  # real Mojang via Miniflare (this VM’s IP)
```

Simulated backend (`test/unit/sim.ts`) covers 403 HTML, 204 vs 404, malformed JSON, extra fields, texture failures, quota, and work-stealing.

## Routes

Worker route `api.ashcon.app/mojang/v4*` plus `*.workers.dev`. Legacy v1/v2 workers stay on their routes.

- `GET /mojang/v2/user/{username|uuid}`
- `GET /mojang/v2/uuid/{username}`
- `GET /mojang/v1/user/{username|uuid}`
- `GET /mojang/v4/user/{username|uuid}` (adds `archive`)
- `GET /mojang/v4/history/{username|uuid}`
- `GET /mojang/v4/health`
- `GET /mojang/v4/debug/egress`
