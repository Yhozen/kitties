import assert from "node:assert/strict";
import test from "node:test";
import { backupEnvironment } from "./backups.ts";

test("restic uses the private binding and requires a separately retained encryption password", () => {
  const env = backupEnvironment("synthetic-password");
  assert.equal(env.RESTIC_REPOSITORY, "rest:http://kitties-backups.internal/");
  assert.equal(env.RESTIC_PASSWORD, "synthetic-password");
  assert.equal(env.RESTIC_CACHE_DIR, "/tmp/restic-cache");
  assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
  assert.throws(() => backupEnvironment(""), /password is missing/);
});
