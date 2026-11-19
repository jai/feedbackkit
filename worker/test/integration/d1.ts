import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * D1 as the Worker uses it, on SQLite in memory with the Worker's own migrations: prepare, bind, first, all, run and
 * batch (one transaction). Real SQL, so the tests check the queries themselves.
 */
export function memoryD1(before?: string): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const folder = new URL("../../migrations/", import.meta.url);
  // `before`: only the migrations named before it, to test the next one on a database as it was.
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith(".sql") && (!before || name < before))
    .sort()) {
    sqlite.exec(readFileSync(new URL(file, folder), "utf8"));
  }
  const values = (params: unknown[]): SQLInputValue[] =>
    params.map(
      (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value === undefined ? null : value) as SQLInputValue,
    );
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>(column?: string): Promise<T | null> {
      const row = sqlite.prepare(sql).get(...values(params)) as Record<string, unknown> | undefined;
      return row === undefined ? null : ((column ? row[column] : { ...row }) as T);
    },
    async all<T>() {
      return {
        results: sqlite
          .prepare(sql)
          .all(...values(params))
          .map((row) => ({ ...row })) as T[],
        success: true,
        meta: {},
      };
    },
    async run() {
      const done = sqlite.prepare(sql).run(...values(params));
      return {
        results: [],
        success: true,
        meta: { changes: Number(done.changes), last_row_id: Number(done.lastInsertRowid) },
      };
    },
  });
  type Statement = ReturnType<typeof statement>;
  return {
    sqlite,
    prepare: (sql: string) => statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        // Synchronous within the transaction, as D1 runs a batch: no other statement can come between.
        const results = statements.map((one) => {
          const prepared = sqlite.prepare(one.sql);
          if (/^\s*select/i.test(one.sql)) {
            return { results: prepared.all(...values(one.params)).map((row) => ({ ...row })), success: true, meta: {} };
          }
          const done = prepared.run(...values(one.params));
          return {
            results: [],
            success: true,
            meta: { changes: Number(done.changes), last_row_id: Number(done.lastInsertRowid) },
          };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database & { sqlite: DatabaseSync };
}

/** An object in `memoryBucket`: text as it came, bytes (a video's) as bytes, with their type. */
type MemoryObject = { body: string | Uint8Array; etag: string; contentType?: string };

/** R2 as the Worker uses it: versions, a put over a moved version refused, prefix listing, text and byte bodies. */
export function memoryBucket(): R2Bucket & { objects: Map<string, MemoryObject> } {
  const objects = new Map<string, MemoryObject>();
  let version = 0;
  const object = (key: string) => {
    const found = objects.get(key)!;
    return {
      key,
      etag: found.etag,
      json: async () => JSON.parse(String(found.body)),
      body: found.body,
      size: typeof found.body === "string" ? found.body.length : found.body.byteLength,
      httpMetadata: { contentType: found.contentType },
    };
  };
  return {
    objects,
    async get(key: string) {
      return objects.has(key) ? object(key) : null;
    },
    async put(
      key: string,
      value: unknown,
      options?: { onlyIf?: { etagMatches?: string } | Headers; httpMetadata?: { contentType?: string } },
    ) {
      const onlyIf = options?.onlyIf;
      if (
        onlyIf instanceof Headers
          ? onlyIf.get("If-None-Match") === "*" && objects.has(key)
          : onlyIf?.etagMatches && objects.get(key)?.etag !== onlyIf.etagMatches
      ) {
        return null;
      }
      const body =
        typeof value === "string"
          ? value
          : value instanceof ArrayBuffer
            ? new Uint8Array(value.slice(0))
            : value instanceof Uint8Array
              ? value.slice()
              : "bytes";
      objects.set(key, { body, etag: `v${++version}`, contentType: options?.httpMetadata?.contentType });
      return object(key);
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 2);
      const truncated = start + 2 < keys.length;
      return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + 2) : undefined };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    },
  } as unknown as R2Bucket & { objects: Map<string, MemoryObject> };
}
