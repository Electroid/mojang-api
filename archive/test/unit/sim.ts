import { http, HttpResponse } from "msw";

export const PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export interface SimPlayer {
  name: string;
  id: string;
  legacy?: boolean;
  demo?: boolean;
  slim?: boolean;
  skin?: boolean;
  cape?: boolean;
  extra?: Record<string, unknown>;
  noProperties?: boolean;
}

function texturesB64(p: SimPlayer): string {
  const textures: Record<string, unknown> = {};
  if (p.skin !== false) {
    textures.SKIN = {
      url: `http://textures.minecraft.net/texture/${p.id}`,
      ...(p.slim ? { metadata: { model: "slim" } } : {}),
    };
  }
  if (p.cape) {
    textures.CAPE = { url: `http://textures.minecraft.net/texture/cape-${p.id}` };
  }
  const payload = {
    timestamp: 1,
    profileId: p.id,
    profileName: p.name,
    textures,
    ...(p.extra || {}),
  };
  return btoa(JSON.stringify(payload));
}

export class MojangSim {
  players = new Map<string, SimPlayer>();
  byId = new Map<string, SimPlayer>();
  quota = 10_000;
  used = 0;
  calls: string[] = [];
  quirks: {
    html403: boolean;
    html404: boolean;
    malformed: boolean;
    extra: boolean;
    name204: boolean;
    session404: boolean;
    dropProperties: boolean;
    textureFail: boolean;
    upstream500: boolean;
  } = {
    html403: false,
    html404: false,
    malformed: false,
    extra: false,
    name204: false,
    session404: false,
    dropProperties: false,
    textureFail: false,
    upstream500: false,
  };

  reset(players?: SimPlayer[]): void {
    this.players.clear();
    this.byId.clear();
    this.quota = 10_000;
    this.used = 0;
    this.calls = [];
    this.quirks = {
      html403: false,
      html404: false,
      malformed: false,
      extra: false,
      name204: false,
      session404: false,
      dropProperties: false,
      textureFail: false,
      upstream500: false,
    };
    for (const p of players || defaultPlayers()) this.add(p);
  }

  add(p: SimPlayer): void {
    this.players.set(p.name.toLowerCase(), p);
    this.byId.set(p.id.replace(/-/g, "").toLowerCase(), p);
  }

  apiCalls(): string[] {
    return this.calls.filter((u) => /mojang\.com|minecraftservices\.com/.test(u));
  }

  handle(request: Request): Response {
    const url = new URL(request.url);
    this.calls.push(url.href);

    if (this.quirks.html403 && /mojang\.com|minecraftservices\.com/.test(url.hostname)) {
      return new HttpResponse("<html><head></head><body>Azure Application Gateway</body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    if (this.quirks.html404 && /mojang\.com|minecraftservices\.com/.test(url.hostname)) {
      return new HttpResponse("<html><head></head><body>Azure Application Gateway</body></html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }
    if (this.quirks.upstream500 && /mojang\.com|minecraftservices\.com/.test(url.hostname)) {
      return HttpResponse.json(
        { error: "Internal Server Error", errorMessage: "The server encountered an unexpected condition which prevented it from fulfilling the request" },
        { status: 500 },
      );
    }

    if (url.hostname === "textures.minecraft.net" || url.hostname === "assets.mojang.com") {
      if (this.quirks.textureFail) return new HttpResponse("nope", { status: 500 });
      return new HttpResponse(PIXEL_PNG, { status: 200, headers: { "content-type": "image/png" } });
    }

    const counts = /mojang\.com|minecraftservices\.com/.test(url.hostname);
    if (counts) {
      this.used += 1;
      if (this.used > this.quota) {
        return HttpResponse.json(
          { error: "TooManyRequestsException", errorMessage: "Rate limit" },
          { status: 429, headers: { "x-minecraft-rate-limit-result": "OVER_LIMIT", "retry-after": "1" } },
        );
      }
    }

    if (this.quirks.malformed && /lookup\/name|profiles\/minecraft/.test(url.pathname)) {
      return new HttpResponse("{not-json", { status: 200, headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && /bulk\/byname|\/profiles\/minecraft$/.test(url.pathname)) {
      return this.bulk(request);
    }

    const nameMatch = url.pathname.match(/\/(?:lookup\/name|profiles\/minecraft)\/([^/]+)$/);
    if (nameMatch) return this.lookupName(decodeURIComponent(nameMatch[1]));

    const sessionMatch = url.pathname.match(/\/session\/minecraft\/profile\/([^/]+)$/);
    if (sessionMatch) return this.session(sessionMatch[1]);

    const uuidMatch = url.pathname.match(/\/lookup\/([0-9a-fA-F-]{32,36})$/);
    if (uuidMatch) return this.lookupUuid(uuidMatch[1]);

    if (url.pathname.includes("/user/profiles/") && url.pathname.endsWith("/names")) {
      return HttpResponse.json({ path: url.pathname, error: "NOT_FOUND", errorMessage: "Not Found" }, { status: 404 });
    }

    return HttpResponse.json({ error: "unhandled", url: url.href }, { status: 599 });
  }

  private lookupName(name: string): Response {
    if (name.length > 16) {
      return HttpResponse.json({ error: "CONSTRAINT_VIOLATION", errorMessage: "Invalid profile name" }, { status: 400 });
    }
    const p = this.players.get(name.toLowerCase());
    if (!p) {
      if (this.quirks.name204) return new HttpResponse(null, { status: 204 });
      return HttpResponse.json(
        { path: `/lookup/name/${name}`, errorMessage: `Couldn't find any profile with name ${name}` },
        { status: 404 },
      );
    }
    return HttpResponse.json(this.identity(p), {
      headers: { "x-minecraft-rate-limit-result": "UNDER_LIMIT", "cache-control": "max-age=300" },
    });
  }

  private lookupUuid(id: string): Response {
    const raw = id.replace(/-/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(raw)) {
      return HttpResponse.json({ path: `/lookup/${id}`, error: "INVALID_JSON", errorMessage: `Invalid UUID string: ${id}` }, { status: 400 });
    }
    const p = this.byId.get(raw);
    if (!p) {
      return HttpResponse.json({ path: `/lookup/${id}`, error: "NOT_FOUND", errorMessage: "Not Found" }, { status: 404 });
    }
    return HttpResponse.json(this.identity(p), {
      headers: { "x-minecraft-rate-limit-result": "UNDER_LIMIT", "cache-control": "max-age=300" },
    });
  }

  private session(id: string): Response {
    const raw = id.replace(/-/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(raw)) {
      return HttpResponse.json({ path: `/session/minecraft/profile/${id}`, errorMessage: `Not a valid UUID: ${id}` }, { status: 400 });
    }
    const p = this.byId.get(raw);
    if (!p) {
      // Historical sessionserver miss is 204 empty (mojang.coffee @throws {204}).
      // 9c905fa also accepts 404 for the same miss.
      if (this.quirks.session404) {
        return HttpResponse.json(
          { path: `/session/minecraft/profile/${id}`, errorMessage: `Couldn't find any profile with id ${id}` },
          { status: 404 },
        );
      }
      return new HttpResponse(null, { status: 204 });
    }
    const body: Record<string, unknown> = {
      id: p.id,
      name: p.name,
      profileActions: [],
    };
    if (!p.noProperties && !this.quirks.dropProperties) {
      body.properties = [{ name: "textures", value: texturesB64(p), signature: "c2ln" }];
    }
    if (p.legacy) body.legacy = true;
    if (p.demo) body.demo = true;
    if (this.quirks.extra) body.unexpectedFutureField = { nested: true };
    return HttpResponse.json(body, {
      headers: { "x-minecraft-rate-limit-result": "UNDER_LIMIT", "cache-control": "max-age=300" },
    });
  }

  private async bulk(request: Request): Promise<Response> {
    let names: unknown;
    try {
      names = await request.json();
    } catch {
      return HttpResponse.json({ error: "CONSTRAINT_VIOLATION" }, { status: 400 });
    }
    if (!Array.isArray(names) || names.length < 1 || names.length > 10) {
      return HttpResponse.json({ error: "CONSTRAINT_VIOLATION", errorMessage: "size must be between 1 and 10" }, { status: 400 });
    }
    const out = [];
    for (const n of names) {
      const p = this.players.get(String(n).toLowerCase());
      if (p) out.push(this.identity(p));
    }
    return HttpResponse.json(out);
  }

  private identity(p: SimPlayer): Record<string, unknown> {
    const row: Record<string, unknown> = { id: p.id, name: p.name };
    if (p.legacy) row.legacy = true;
    if (p.demo) row.demo = true;
    if (this.quirks.extra) row.unexpectedFutureField = true;
    return row;
  }

  handlers() {
    return [
      http.all(/.*/, ({ request }) => {
        const host = new URL(request.url).hostname;
        if (
          host.endsWith("mojang.com") ||
          host.endsWith("minecraftservices.com") ||
          host.endsWith("minecraft.net")
        ) {
          return this.handle(request);
        }
        return undefined;
      }),
    ];
  }
}

export function defaultPlayers(): SimPlayer[] {
  return [
    { name: "Notch", id: "069a79f444e94726a5befca90e38aaf5", skin: true },
    { name: "jeb_", id: "853c80ef3c3749fdaa49938b674adae6", skin: true, cape: true },
    { name: "Steve", id: "8667ba71b85a4004af54457a9734eed7", skin: true, cape: true },
    { name: "Alex", id: "ec561538f3fd461daff5086b22154bce", skin: true, slim: true },
    { name: "NoSkin", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", skin: false, noProperties: false },
  ];
}

export const sim = new MojangSim();
