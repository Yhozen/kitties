import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const LIBRARY_IMAGE_VERSION = 1;
export const LIBRARY_IMAGE_VALUE_BYTES = 2 * 1024 * 1024;
export const LIBRARY_IMAGE_PART_CHARS = 8192;
export const LIBRARY_IMAGE_RESPONSE_BYTES = 32768;

export class LibraryImageError extends Schema.TaggedError<
  LibraryImageError,
  { readonly brand: unique symbol }
>()("LibraryImageError", {
  reason: Schema.Literals(["invalid", "unsupported", "limit", "conflict", "incomplete", "storage"]),
}) {}

interface NativeRecord {
  readonly [key: string]: LibraryNativeValue;
}

export type LibraryNativeValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | ArrayBuffer
  | Uint8Array
  | ReadonlyArray<LibraryNativeValue>
  | NativeRecord;

type ImageValue =
  | { readonly _tag: "Undefined" }
  | { readonly _tag: "Null" }
  | { readonly _tag: "Boolean"; readonly value: boolean }
  | { readonly _tag: "Number"; readonly value: string }
  | { readonly _tag: "String"; readonly value: string }
  | { readonly _tag: "BigInt"; readonly value: string }
  | { readonly _tag: "Date"; readonly value: string }
  | { readonly _tag: "Buffer"; readonly value: string }
  | { readonly _tag: "Bytes"; readonly value: string }
  | { readonly _tag: "Array"; readonly values: ReadonlyArray<ImageValue> }
  | { readonly _tag: "Record"; readonly entries: ReadonlyArray<readonly [string, ImageValue]> };

const ImageValue: Schema.Codec<ImageValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.Struct({ _tag: Schema.Literals(["Undefined", "Null"]) }),
    Schema.Struct({ _tag: Schema.Literal("Boolean"), value: Schema.Boolean }),
    Schema.Struct({
      _tag: Schema.Literals(["Number", "String", "BigInt", "Date", "Buffer", "Bytes"]),
      value: Schema.String,
    }),
    Schema.Struct({ _tag: Schema.Literal("Array"), values: Schema.Array(ImageValue) }),
    Schema.Struct({
      _tag: Schema.Literal("Record"),
      entries: Schema.Array(Schema.Tuple([Schema.String, ImageValue])),
    }),
  ]),
);

const Image = Data.taggedEnum<ImageValue>();

const fail = (reason: LibraryImageError["reason"]): never => {
  throw new LibraryImageError({ reason });
};

export const libraryImageBytes = (text: string): number => new TextEncoder().encode(text).length;

const base64 = (bytes: Uint8Array): string => {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }

  return btoa(binary);
};

const unbase64 = (text: string): Uint8Array => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    return fail("invalid");
  const bytes = Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

  if (base64(bytes) !== text) return fail("invalid");

  return bytes;
};

/** Strict lossless codec for the first-party Library's native values; unsupported graphs fail. */
export const encodeLibraryValue = <A>(input: A): string => {
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = <Value>(value: Value, depth: number): ImageValue => {
    nodes += 1;

    if (depth > 64 || nodes > 65536) return fail("limit");

    if (value === undefined) return Image.Undefined();

    if (value === null) return Image.Null();

    if (Predicate.isBoolean(value)) return Image.Boolean({ value });

    if (Predicate.isString(value)) return Image.String({ value });

    if (Predicate.isNumber(value)) {
      return Image.Number({
        value: Object.is(value, -0) ? "-0" : String(value),
      });
    }

    if (Predicate.isBigInt(value)) return Image.BigInt({ value: String(value) });

    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) return fail("unsupported");

      return Image.Date({ value: value.toISOString() });
    }

    if (value instanceof ArrayBuffer) return Image.Buffer({ value: base64(new Uint8Array(value)) });

    if (value instanceof Uint8Array) return Image.Bytes({ value: base64(value) });

    if (!Predicate.isObjectOrArray(value)) return fail("unsupported");

    if (ancestors.has(value)) return fail("unsupported");
    ancestors.add(value);

    try {
      if (Arr.isArray(value)) {
        if (
          Object.getOwnPropertyNames(value).length !== value.length + 1 ||
          Object.getOwnPropertySymbols(value).length !== 0
        )
          return fail("unsupported");

        return Image.Array({
          values: Array.from({ length: value.length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
              return fail("unsupported");

            return visit(descriptor.value, depth + 1);
          }),
        });
      }

      if (
        (Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0
      )
        return fail("unsupported");
      const entries: [string, ImageValue][] = [];

      for (const key of Object.getOwnPropertyNames(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          return fail("unsupported");
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }

      return Image.Record({ entries });
    } finally {
      ancestors.delete(value);
    }
  };

  const text = JSON.stringify(visit(input, 0));

  if (libraryImageBytes(text) > LIBRARY_IMAGE_VALUE_BYTES) return fail("limit");

  return text;
};

export const decodeLibraryValue = (text: string): LibraryNativeValue => {
  if (libraryImageBytes(text) > LIBRARY_IMAGE_VALUE_BYTES) return fail("limit");
  const encoded = Schema.decodeUnknownSync(Schema.fromJsonString(ImageValue))(text);
  let nodes = 0;

  const visit = (value: ImageValue, depth: number): LibraryNativeValue => {
    nodes += 1;

    if (depth > 64 || nodes > 65536) return fail("limit");

    return Match.value(value).pipe(
      Match.tag("Undefined", () => undefined),
      Match.tag("Null", () => null),
      Match.tag("Boolean", (item) => item.value),
      Match.tag("String", (item) => item.value),
      Match.tag("Number", (item) => {
        const number = Number(item.value);

        if ((Object.is(number, -0) ? "-0" : String(number)) !== item.value) return fail("invalid");

        return number;
      }),
      Match.tag("BigInt", (item) => {
        if (!/^-?(0|[1-9][0-9]*)$/.test(item.value) || item.value === "-0") return fail("invalid");

        return BigInt(item.value);
      }),
      Match.tag("Date", (item) => {
        const date = new Date(item.value);

        if (!Number.isFinite(date.getTime()) || date.toISOString() !== item.value)
          return fail("invalid");

        return date;
      }),
      Match.tag("Buffer", (item) => new Uint8Array(unbase64(item.value)).buffer),
      Match.tag("Bytes", (item) => unbase64(item.value)),
      Match.tag("Array", (item) => item.values.map((entry) => visit(entry, depth + 1))),
      Match.tag("Record", (item) => {
        let previous: string | undefined;

        return Object.fromEntries(
          item.entries.map(([key, entry]) => {
            if (previous !== undefined && previous >= key) return fail("invalid");
            previous = key;

            return [key, visit(entry, depth + 1)];
          }),
        );
      }),
      Match.exhaustive,
    );
  };

  const value = visit(encoded, 0);

  if (encodeLibraryValue(value) !== text) return fail("invalid");

  return value;
};

export const libraryImageDigest = (text: string) =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      );

      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: () => new LibraryImageError({ reason: "storage" }),
  });
