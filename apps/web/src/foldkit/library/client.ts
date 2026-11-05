import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { LibraryApi } from "@kitties/domain/LibraryApi.api";

export const LibraryClient = DomainFoldkit.make(LibraryApi);
