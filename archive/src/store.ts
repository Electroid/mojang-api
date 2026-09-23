import { freeze, thaw, stamp, meta, HTTP_TABLE, dump, type StoredHttp } from "./raw";
import { sqlRows } from "./safe";

type Sql = { exec: (query: string, ...args: unknown[]) => { [Symbol.iterator](): IterableIterator<unknown> } };

export function ensureHttp(sql: Sql): void {
  try {
    sql.exec(HTTP_TABLE);
  } catch {
    /* ignore */
  }
}

export async function insertHttp(sql: Sql, res: Response, url?: string): Promise<void> {
  try {
    const frozen = await freeze(res);
    const at = Number(meta(res, "at")) || Date.now();
    const target = url || meta(res, "url") || "";
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

export function listHttp(sql: Sql, limit = 50): StoredHttp[] {
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
      if (Object.keys(extra).length) response = stamp(response, extra);
      return { response, body, url, at };
    });
  } catch {
    return [];
  }
}

export { dump };
