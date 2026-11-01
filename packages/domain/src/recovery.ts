import * as Schema from "effect/Schema";
export const RecoveryKind = Schema.Literals(["home", "kitty", "chat", "workflow"]);
export const RecoveryView = Schema.Struct({
  control: Schema.Struct({
    epoch: Schema.Number,
    mode: Schema.String,
    operation_id: Schema.NullOr(Schema.String),
  }),
  objects: Schema.Array(Schema.Struct({ kind: RecoveryKind, name: Schema.String })),
  exports: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      at: Schema.Number,
      parts: Schema.optional(Schema.Number),
      objects: Schema.optional(Schema.Number),
    }),
  ),
  restores: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      at: Schema.Number,
      kind: RecoveryKind,
      name: Schema.String,
      epoch: Schema.Number,
    }),
  ),
  reviews: Schema.Array(
    Schema.Struct({ workflow: Schema.String, id: Schema.String, epoch: Schema.Number }),
  ),
  purges: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      at: Schema.Number,
      objects: Schema.Number,
    }),
  ),
});
