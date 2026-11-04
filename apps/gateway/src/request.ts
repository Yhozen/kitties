import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
export const readBody = <S extends Schema.Top>(request: Request, schema: S) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        if (Number(request.headers.get("Content-Length")) > 1024 * 1024) throw Error();
        const reader = request.body?.getReader();
        if (!reader) throw Error();
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1024 * 1024) throw Error();
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const all = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          all.set(chunk, at);
          at += chunk.length;
        }
        return JSON.parse(new TextDecoder().decode(all));
      },
      catch: () => "INVALID_REQUEST",
    });
    return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError(() => "INVALID_REQUEST"),
    );
  });
