import * as Effect from "effect/Effect";
import { HomeDO, ChatDO } from "./actors.ts";
import { makeRecovery } from "./recovery.ts";
import { open, type Envelope } from "./secrets.ts";
import { Turn } from "./turn-definition.ts";
import { DesktopAttempt } from "./desktop-definition.ts";

// Invoked only by the authenticated acceptance Worker in next/e2e.
export const makeSecretAudit = Effect.gen(function* () {
  const homes = yield* HomeDO,
    chats = yield* ChatDO,
    recovery = yield* makeRecovery;
  return (needle: string, chatId: string, messages: readonly string[], kek: string) =>
    Effect.gen(function* () {
      if (!needle || needle.length > 8192 || messages.length > 10) throw Error("INVALID_AUDIT");
      const home = homes.getByName("owner"),
        chat = chats.getByName(chatId);
      let leaked = (yield* home.adminContains(needle)) || (yield* chat.adminContains(needle)),
        rows = 0;
      for (const message of messages) {
        const run = yield* chat.run(message);
        if (!run?.run_id) throw Error("AUDIT_RUN_MISSING");
        const job = yield* home.read("desktop-help", `${run.run_id}/0/0`);
        if (!job) throw Error("AUDIT_CHILD_MISSING");
        for (const name of [
          `${Turn._tag}/${run.run_id}`,
          `${DesktopAttempt._tag}/${(JSON.parse(job) as { executionId: string }).executionId}`,
        ]) {
          const actor = recovery.actor("workflow", name),
            id = `audit-${crypto.randomUUID()}`;
          const capture = JSON.parse(yield* actor.adminCapture(id)) as {
            tables: { table: string; rows: number }[];
          };
          for (const table of capture.tables)
            for (let row = 1; row <= table.rows; row++) {
              let body = "";
              for (let part = 0; ; part++) {
                if (part >= 1000) throw Error("AUDIT_ROW_LIMIT");
                const aad = `audit:${id}:${table.table}:${row}:${part}`,
                  value = yield* actor.adminExportPart(id, table.table, row, part, aad);
                const decoded = yield* Effect.promise(() =>
                  open(kek, aad, JSON.parse(value.body) as Envelope),
                );
                body += (JSON.parse(decoded) as { chunk: string }).chunk;
                if (value.last) break;
              }
              leaked ||= body.includes(needle);
              rows++;
            }
        }
      }
      return { leaked, workflowRows: rows, homeAndChatRowsScanned: true };
    });
});
