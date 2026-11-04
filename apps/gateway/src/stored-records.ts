import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";
import {
  ProviderInput,
  ConnectionInput,
  KittyInput,
  ChatView,
  ApprovalView,
  GoalView,
  HookInput,
} from "./entities.ts";

export const mutableRecord = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));

// Stored records retain additional journal fields when a reader only needs part of a record.
export const stored = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  body: string,
): S["Type"] => {
  const value: unknown = JSON.parse(body);

  if (Schema.is(schema)(value)) return value;

  return Schema.decodeUnknownSync(schema)(value);
};

export const EnvelopeRecord = Schema.Struct({
  kid: Schema.String,
  iv: Schema.String,
  ct: Schema.String,
});

const { apiKey: _apiKey, ...providerFields } = ProviderInput.fields;

export const ProviderRecord = Schema.Struct({
  ...providerFields,
  id: Schema.String,
  secret: Schema.optional(EnvelopeRecord),
});

const { token: _token, ...connectionFields } = ConnectionInput.fields;

export const ConnectionRecord = Schema.Struct({
  ...connectionFields,
  id: Schema.String,
  secret: Schema.optional(EnvelopeRecord),
});

export const KittyRecord = Schema.Struct({
  ...KittyInput.fields,
  id: Schema.String,
  createdAt: Schema.Number,
});

export const ChatRecord = ChatView;

export const ApprovalRecord = mutableRecord({
  ...ApprovalView.fields,
  policyKey: Schema.optional(Schema.String),
});

export const GoalRecord = GoalView;

export const HookRecord = Schema.Struct({
  goalId: Schema.String,
  kind: HookInput.fields.kind,
  secret: EnvelopeRecord,
});

export const ExecutionRecord = Schema.Struct({ executionId: Schema.String });
export const StatusRecord = Schema.Struct({ status: Schema.optional(Schema.String) });
export const NameRecord = Schema.Struct({ name: Schema.String });
