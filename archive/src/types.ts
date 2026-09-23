export interface Env {
  ARCHIVE_NAMES: DurableObjectNamespace;
  ARCHIVE_PROFILES: DurableObjectNamespace;
  ARCHIVE_EGRESS: DurableObjectNamespace;
  ARCHIVE_CLIENTS: DurableObjectNamespace;
  ARCHIVE_TCP: DurableObjectNamespace;
  EGRESS_METHODS: string;
  TCP_SHARDS: string;
  FRESH_MS: string;
  NEGATIVE_MS: string;
  TOKEN_RESERVE: string;
}

export type EgressMethod = "socket" | "do-fetch" | "fetch";
export type Priority = "new" | "missing" | "refresh";
export type CacheHit = "fresh" | "stale" | "miss" | "stale-error" | "negative";

export interface EgressAttempt {
  method: EgressMethod;
  url: string;
  via?: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  localAddress?: string | null;
  remoteAddress?: string | null;
  bodyPreview?: string;
  classified?: string;
}

export interface EgressResult {
  ok: boolean;
  status: number;
  body: string | null;
  json: unknown;
  method: EgressMethod | "cache" | "none" | "skipped";
  via?: string;
  attempts: EgressAttempt[];
  localAddress?: string | null;
  classified: Classify;
  skipped?: boolean;
  response?: Response;
}

export type Classify =
  | "ok"
  | "missing"
  | "invalid"
  | "ratelimit"
  | "blocked"
  | "upstream"
  | "garbage"
  | "skipped"
  | "network";

export interface ClientPolicy {
  hitsLastMinute: number;
  maxStaleMs: number;
  allowRefresh: boolean;
}

export interface NameState {
  name: string;
  uuid: string | null;
  lastStatus: number | null;
  firstSeenAt: number | null;
  firstAliveAt: number | null;
  firstMissingAt: number | null;
  lastAliveAt: number | null;
  lastMissingAt: number | null;
  lastRefreshAt: number | null;
}

export interface SessionProfile {
  id?: unknown;
  name?: unknown;
  properties?: unknown;
  legacy?: unknown;
  demo?: unknown;
  profileActions?: unknown;
  [key: string]: unknown;
}

export interface TexturePayload {
  timestamp?: unknown;
  profileId?: unknown;
  profileName?: unknown;
  signatureRequired?: unknown;
  textures?: {
    SKIN?: { url?: unknown; metadata?: { model?: unknown } };
    CAPE?: { url?: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Permit {
  ok: boolean;
  tokens: number;
  reason: string;
}
