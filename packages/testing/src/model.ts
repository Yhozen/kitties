import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/ai/LanguageModel";
import type * as Response from "effect/ai/Response";

// Each provider call consumes exactly one scripted round; retries are visible.
export const scriptedLanguageModel = (
  rounds: readonly {
    content: Response.PartEncoded[];
    stream: Response.StreamPartEncoded[];
  }[],
) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      let index = 0;
      const next = () => {
        const round = rounds[index++];
        if (!round) throw new Error(`Scripted model exhausted at round ${index}`);
        return round;
      };
      return yield* LanguageModel.make({
        generateText: () => Effect.sync(() => next().content),
        streamText: () => Stream.suspend(() => Stream.fromIterable(next().stream)),
      });
    }),
  );
