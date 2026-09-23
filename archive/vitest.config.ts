import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const wrangler = { configPath: "./wrangler.toml" } as const;

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler,
            miniflare: {
              bindings: {
                EGRESS_METHODS: "fetch",
                TCP_SHARDS: "1",
                FRESH_MS: "300000",
                NEGATIVE_MS: "60000",
                TOKEN_RESERVE: "4",
              },
            },
          }),
        ],
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          setupFiles: ["./test/unit/setup.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler,
            miniflare: {
              bindings: {
                // Miniflare cloudflare:sockets TLS to Mojang is unreliable
                // ("Network connection lost"). E2E hits real Mojang over fetch
                // from this VM IP. Production uses EGRESS_METHODS=socket,fetch.
                EGRESS_METHODS: "fetch",
                TCP_SHARDS: "1",
              },
            },
          }),
        ],
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          testTimeout: 45_000,
        },
      },
    ],
  },
});
