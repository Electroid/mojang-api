/** Never-throw helpers. The archive must keep serving through schema drift and infra failures. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

export function tryJson(text: string | null | undefined): unknown {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[\[{]/);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function looksLikeHtml(body: string | null | undefined, contentType?: string | null): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) return true;
  if (!body) return false;
  const head = body.slice(0, 160).trim().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<head>") || head.includes("azure application gateway");
}

export async function never<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function sleep(ms: number): Promise<void> {
  const n = Math.max(0, Math.min(ms, 5_000));
  return new Promise((r) => setTimeout(r, n));
}

export function envInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function sqlRows<T = Record<string, unknown>>(cursor: { [Symbol.iterator](): IterableIterator<unknown> }): T[] {
  try {
    return [...cursor] as T[];
  } catch {
    return [];
  }
}

export function sqlFirst<T = Record<string, unknown>>(cursor: { [Symbol.iterator](): IterableIterator<unknown> }): T | null {
  return sqlRows<T>(cursor)[0] ?? null;
}
