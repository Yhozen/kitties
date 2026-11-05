import * as Clock from "effect/Clock";
import * as Context from "effect/Context";

/** Optional trusted policy clock; native scheduling and capture timestamps keep their own clock. */
export class LibraryCapturePruneClock extends Context.Service<
  LibraryCapturePruneClock,
  Clock.Clock
>()("@kitties/gateway/LibraryCapturePruneClock") {}
