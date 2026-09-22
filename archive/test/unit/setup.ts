import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { reset } from "cloudflare:test";
import { network } from "./network";
import { sim } from "./sim";

beforeAll(() => {
  network.enable();
});

beforeEach(() => {
  sim.reset();
  network.use(...sim.handlers());
});

afterEach(async () => {
  network.resetHandlers();
  await reset();
});

afterAll(() => {
  network.disable();
});
