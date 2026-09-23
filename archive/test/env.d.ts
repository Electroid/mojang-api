import type { Env } from "../src/types";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
