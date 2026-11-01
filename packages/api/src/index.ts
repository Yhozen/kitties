import { Health, Session } from "@kitties/domain";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

export const Api = HttpApi.make("Kitties").add(
  HttpApiGroup.make("system").add(
    HttpApiEndpoint.get("health", "/v1/health", { success: Health }),
    HttpApiEndpoint.get("session", "/v1/session", { success: Session }),
  ),
);
export const client = HttpApiClient.make(Api);
