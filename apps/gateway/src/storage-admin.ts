import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { seal } from "./secrets.ts";

export const makeStorageAdmin = (
  state: Effect.Success<typeof Cloudflare.DurableObjectState>,
  kek: string,
  tables: readonly string[],
) => {
  const sql = state.raw.storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS admin_exports (id TEXT NOT NULL,table_name TEXT NOT NULL,row_number INTEGER NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(id,table_name,row_number))",
  );
  sql.exec("CREATE TABLE IF NOT EXISTS admin_captures (id TEXT PRIMARY KEY,body TEXT NOT NULL)");

  return {
    adminContains: (value: string) =>
      Effect.sync(() => {
        if (!value || value.length > 8192) throw Error("INVALID_AUDIT_VALUE");

        for (const table of tables) {
          const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();

          for (const { name } of columns) {
            if (!/^[a-z_]+$/.test(name)) throw Error("INVALID_COLUMN");

            if (
              sql
                .exec(
                  `SELECT 1 FROM "${table}" WHERE instr(CAST("${name}" AS TEXT),?)>0 LIMIT 1`,
                  value,
                )
                .toArray().length
            )
              return true;
          }
        }

        return false;
      }),
    adminBookmark: (at?: number) =>
      Effect.tryPromise({
        try: () =>
          at === undefined
            ? state.raw.storage.getCurrentBookmark()
            : state.raw.storage.getBookmarkForTime(at),
        catch: () => "PITR_UNAVAILABLE",
      }),
    adminPrepareRestore: (bookmark: string) =>
      Effect.tryPromise({
        try: () => state.raw.storage.onNextSessionRestoreBookmark(bookmark),
        catch: () => "PITR_UNAVAILABLE",
      }),
    adminEvict: () => Effect.sync(() => state.raw.abort("Operator recovery restart")),
    adminCapture: (id: string) =>
      Effect.sync(() =>
        state.raw.storage.transactionSync(() => {
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw Error("INVALID_EXPORT_ID");

          const saved = sql
            .exec<{ body: string }>("SELECT body FROM admin_captures WHERE id=?", id)
            .toArray()[0];

          if (saved) return saved.body;
          const result: { table: string; rows: number }[] = [];

          for (const table of tables) {
            if (!/^[a-z_]+$/.test(table)) throw Error("INVALID_TABLE");

            const columns = sql
              .exec<{ name: string }>(`PRAGMA table_info(${table})`)
              .toArray()
              .map((c) => c.name);

            if (!columns.length) continue;

            const pairs = columns
              .map((c) => {
                if (!/^[a-z_]+$/.test(c)) throw Error("INVALID_COLUMN");

                return `'${c}',CASE WHEN typeof("${c}")='blob' THEN json_object('$blob',hex("${c}")) ELSE "${c}" END`;
              })
              .join(",");

            sql.exec(
              `INSERT INTO admin_exports SELECT ?,?,ROW_NUMBER() OVER (),json_object(${pairs}),? FROM "${table}"`,
              id,
              table,
              Date.now(),
            );
            result.push({
              table,
              rows: sql
                .exec<{ n: number }>(
                  "SELECT COUNT(*) AS n FROM admin_exports WHERE id=? AND table_name=?",
                  id,
                  table,
                )
                .toArray()[0]!.n,
            });
          }

          const body = JSON.stringify({ id, at: Date.now(), tables: result });
          sql.exec("INSERT INTO admin_captures VALUES (?,?)", id, body);

          return body;
        }),
      ),
    adminExportPart: (id: string, table: string, row: number, part: number, aad: string) =>
      Effect.tryPromise({
        try: async () => {
          const value = sql
            .exec<{ chunk: string; length: number }>(
              "SELECT substr(body,?,32768) AS chunk,length(body) AS length FROM admin_exports WHERE id=? AND table_name=? AND row_number=?",
              part * 32768 + 1,
              id,
              table,
              row,
            )
            .toArray()[0];

          if (!value || part < 0 || part * 32768 >= value.length) throw Error();

          const envelope = await seal(
            kek,
            aad,
            JSON.stringify({ table, row, part, chunk: value.chunk }),
          );

          return { body: JSON.stringify(envelope), last: (part + 1) * 32768 >= value.length };
        },
        catch: () => "EXPORT_UNAVAILABLE",
      }),
    adminPurge: (before: number) =>
      Effect.sync(() => {
        sql.exec(
          "DELETE FROM admin_captures WHERE id IN (SELECT DISTINCT id FROM admin_exports WHERE at<?)",
          before,
        );
        sql.exec("DELETE FROM admin_exports WHERE at<?", before);
      }),
  };
};
