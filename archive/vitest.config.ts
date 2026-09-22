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
                EGRESS_PROXIES: "",
                EGRESS_METHODS: "fetch",
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
                // Miniflare's cloudflare:sockets TLS to Mojang rejects after the
                // request already failed over to proxy/fetch. E2E still hits real
                // Mojang (and the Fly hop) over fetch.
                EGRESS_METHODS: "proxy,fetch",
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
