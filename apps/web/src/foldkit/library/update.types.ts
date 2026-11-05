import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import type { Update } from "foldkit";
import { LibraryClientAuthentication } from "./LibraryClientAuthentication.ts";
import type { Message } from "./message.ts";
import type { Model } from "./model.ts";

export type LibraryServices = typeof LibraryApi.Client.Identifier | LibraryClientAuthentication;

export type UpdateReturn = Update.Return<Model, Message, LibraryServices>;
