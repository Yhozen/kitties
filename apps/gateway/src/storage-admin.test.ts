import { DatabaseSync } from "node:sqlite";
import { test, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeStorageAdmin } from "./storage-admin.ts";
import { open } from "./secrets.ts";

test("export captures immutable rows and encrypts bounded Unicode chunks with path authentication", async () => {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const statement = database.prepare(query);
      const rows = statement.all(...(args as (string | number | null)[]));
      return { toArray: () => rows };
    },
  };
  const raw = {
    storage: {
      sql,
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
  };
  const state = { raw } as unknown as Effect.Success<typeof Cloudflare.DurableObjectState>;
  database.exec("CREATE TABLE records (id TEXT PRIMARY KEY,body TEXT,bytes BLOB)");
  const value = "Á🐈".repeat(60000),
    kek = "ab".repeat(32);
  database
    .prepare("INSERT INTO records VALUES (?,?,?)")
    .run("one", value, new Uint8Array([0, 255, 12]));
  const admin = makeStorageAdmin(state, kek, ["records"]),
    run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const snapshot = await run(admin.adminCapture("snapshot"));
  database.prepare("UPDATE records SET body=?").run("modified");
  expect(await run(admin.adminCapture("snapshot"))).toBe(snapshot);
  let body = "",
    parts = 0;
  for (; ; parts++) {
    const aad = `export:records:1:${parts}`,
      part = await run(admin.adminExportPart("snapshot", "records", 1, parts, aad));
    expect(part.body.length).toBeLessThan(300000);
    const envelope = JSON.parse(part.body);
    expect(part.body).not.toContain("Á🐈");
    const decoded = JSON.parse(await open(kek, aad, envelope));
    body += decoded.chunk;
    await expect(open(kek, aad + "wrong", envelope)).rejects.toThrow();
    if (part.last) break;
  }
  expect(parts).toBeGreaterThan(2);
  expect(JSON.parse(body)).toEqual({ id: "one", body: value, bytes: { $blob: "00FF0C" } });
  await run(admin.adminPurge(Date.now() + 1));
  await expect(run(admin.adminExportPart("snapshot", "records", 1, 0, "aad"))).rejects.toThrow();
  database.close();
});
