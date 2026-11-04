import { DatabaseSync } from "node:sqlite";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Effect from "effect/Effect";

export function sqliteFixture() {
  const database = new DatabaseSync(":memory:");
  const state = {
    raw: {
      storage: {
        sql: {
          exec: (query: string, ...args: (string | number | null)[]) => {
            const statement = database.prepare(query);
            const rows = statement.all(...args);
            return { toArray: () => rows };
          },
        },
        transactionSync: <A>(f: () => A) => {
          database.exec("BEGIN");
          try {
            const value = f();
            database.exec("COMMIT");
            return value;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      },
    },
  } as unknown as Effect.Success<typeof Cloudflare.DurableObjectState>;
  return { database, state };
}
