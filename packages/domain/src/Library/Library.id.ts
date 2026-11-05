import * as Schema from "effect/Schema";

export const LibraryId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)).pipe(
  Schema.brand("LibraryId"),
);

export type LibraryId = typeof LibraryId.Type;
