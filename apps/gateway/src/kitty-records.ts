import * as Schema from "effect/Schema";
import type { ComputerState } from "./computer-state.ts";
import type { FileLease } from "./file-leases.ts";
import type { Grant } from "./control.ts";

export const ComputerRecord: Schema.Codec<ComputerState> = Schema.Struct({
  kittyId: Schema.String,
  generation: Schema.Number,
  phase: Schema.Literals([
    "absent",
    "starting",
    "ready",
    "draining",
    "archiving",
    "sleeping",
    "restoring",
    "deleting",
    "deleted",
    "attention",
  ]),
  remoteId: Schema.optional(Schema.String),
  tokenVersion: Schema.Number,
  previousIds: Schema.mutable(Schema.Array(Schema.String)),
  operation: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["start", "sleep", "restore", "delete", "upgrade"]),
      at: Schema.Number,
      generation: Schema.Number,
      key: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      sourceCheckpointId: Schema.optional(Schema.String),
    }),
  ),
  receipt: Schema.optional(
    Schema.Struct({
      remoteId: Schema.String,
      generation: Schema.Number,
      key: Schema.String,
      body: Schema.String,
      at: Schema.Number,
    }),
  ),
  quiesced: Schema.optional(
    Schema.Struct({ remoteId: Schema.String, generation: Schema.Number, at: Schema.Number }),
  ),
  checkpoint: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      snapshotId: Schema.String,
      sourceRemoteId: Schema.String,
      generation: Schema.Number,
      quiesced: Schema.Boolean,
      at: Schema.Number,
    }),
  ),
  lastRenewAt: Schema.Number,
  lastActiveAt: Schema.Number,
  failureCount: Schema.Number,
});

export const FileLeasesRecord: Schema.Codec<FileLease[]> = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      remoteId: Schema.String,
      generation: Schema.Number,
      expiresAt: Schema.Number,
    }),
  ),
);

export const GrantRecord: Schema.Codec<Grant> = Schema.Struct({
  kittyId: Schema.String,
  generation: Schema.Number,
  remoteId: Schema.String,
  epoch: Schema.Number,
  nonce: Schema.String,
  clientId: Schema.String,
  expiresAt: Schema.Number,
  lastInputAt: Schema.Number,
  draining: Schema.Boolean,
});
