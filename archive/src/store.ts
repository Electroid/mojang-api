import { freeze, thaw, stamp, meta, HTTP_TABLE, dump, kindFromUrl, type StoredHttp } from "./raw";
import { sqlRows } from "./safe";

type Sql = { exec: (query: string, ...args: unknown[]) => { [Symbol.iterator](): IterableIterator<unknown> } };

export function ensureHttp(sql: Sql): void {
  try {
    sql.exec(HTTP_TABLE);
    sql.exec(`CREATE INDEX IF NOT EXISTS http_at ON http(at)`);
  } catch {
    /* ignore */
  }
}

/** Append-only ledger row: exact Response at this timestamp. */
export async function insertHttp(sql: Sql, res: Response, url?: string): Promise<void> {
  try {
    const target = url || meta(res, "url") || "";
    const extra: Record<string, string> = {};
    if (!meta(res, "kind")) extra.kind = kindFromUrl(target);
    if (!meta(res, "url") && target) extra.url = target;
    const toStore = Object.keys(extra).length ? stamp(res.clone(), extra) : res;
    const frozen = await freeze(toStore);
    const at = Number(meta(toStore, "at")) || Number(meta(res, "at")) || Date.now();
    sql.exec(
      `INSERT INTO http (at, url, status, headers, body) VALUES (?, ?, ?, ?, ?)`,
      at,
      target,
      frozen.status,
      frozen.headers,
      frozen.body,
    );
  } catch {
    /* ignore */
  }
}

export function listHttp(sql: Sql, limit = 2000): StoredHttp[] {
  try {
    const rows = sqlRows<{
      at: number;
      url: string;
      status: number;
      headers: string;
      body: string;
    }>(sql.exec(`SELECT at, url, status, headers, body FROM http ORDER BY at ASC LIMIT ?`, limit));
    return rows.map((r) => {
      const body = String(r.body || "");
      const url = String(r.url || "");
      const at = Number(r.at) || 0;
      let response = thaw(Number(r.status) || 502, String(r.headers || ""), body);
      const extra: Record<string, string | number> = {};
      if (!meta(response, "url") && url) extra.url = url;
      if (!meta(response, "at") && at) extra.at = at;
      if (!meta(response, "kind") && url) extra.kind = kindFromUrl(url);
      if (Object.keys(extra).length) response = stamp(response, extra);
      return { response, body, url, at };
    });
  } catch {
    return [];
  }
}

export { dump };
