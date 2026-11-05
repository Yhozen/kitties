import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  decodeLibraryValue,
  encodeLibraryValue,
  LibraryImageError,
  libraryImageDigest,
} from "./library-image.ts";

it.effect("round-trips native values that JSON alone loses with a stable digest", () =>
  Effect.gen(function* () {
    const original = {
      undefined,
      numbers: [-0, Number.NaN, Infinity, -Infinity],
      big: 9007199254740993n,
      date: new Date("2026-11-05T00:00:00.000Z"),
      bytes: new Uint8Array([0, 1, 254, 255]),
      buffer: new Uint8Array([2, 3]).buffer,
      text: "🧶\ud800",
    };

    const encoded = encodeLibraryValue(original);
    expect(decodeLibraryValue(encoded)).toEqual(original);
    expect(encodeLibraryValue({ b: 2, a: 1 })).toBe(encodeLibraryValue({ a: 1, b: 2 }));
    expect(yield* libraryImageDigest("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  }),
);

it.effect("refuses unsupported graphs, ambiguous records and over-limit bodies", () =>
  Effect.sync(() => {
    interface Cycle {
      self?: object;
    }

    const cycle: Cycle = {};
    cycle.self = cycle;
    expect(() => encodeLibraryValue(cycle)).toThrow(LibraryImageError);
    expect(() => encodeLibraryValue(new Map([["body", "must not disappear"]]))).toThrow(
      LibraryImageError,
    );
    expect(() => encodeLibraryValue(Array(2))).toThrow(LibraryImageError);
    expect(() =>
      encodeLibraryValue(Object.assign(Array(1), { extra: "must not replace a hole" })),
    ).toThrow(LibraryImageError);
    const annotated = ["body"];
    Object.defineProperty(annotated, "hidden", { value: "must not disappear" });
    expect(() => encodeLibraryValue(annotated)).toThrow(LibraryImageError);
    expect(() =>
      encodeLibraryValue(Object.assign(["body"], { [Symbol("private")]: "retained" })),
    ).toThrow(LibraryImageError);
    expect(() => encodeLibraryValue("x".repeat(2 * 1024 * 1024))).toThrow(LibraryImageError);
    expect(() =>
      decodeLibraryValue(
        '{"_tag":"Record","entries":[["a",{"_tag":"Null"}],["a",{"_tag":"Null"}]]}',
      ),
    ).toThrow(LibraryImageError);
    expect(() => decodeLibraryValue('{"_tag":"Number","value":"01"}')).toThrow(LibraryImageError);
  }),
);
