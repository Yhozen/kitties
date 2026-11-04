import type * as cf from "@cloudflare/workers-types";

// R2 emits byte chunks, but its Workers stream type and the DOM stream type have
// different BYOB readers. Bridge the reader without buffering an entire object.
export function blobStream(source: cf.ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
