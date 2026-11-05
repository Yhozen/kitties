import { Subscription } from "foldkit";
import * as Library from "../library/index.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";

export const subscriptions = Subscription.lift(Library.subscriptions)<Model, Message>({
  read: (model) => model.maybeLibrary,
  toParentMessage: (message) => Message.GotLibraryMessage({ message }),
});
