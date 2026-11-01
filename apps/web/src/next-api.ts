import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import type * as HttpClient from 'effect/http/HttpClient';
import {client} from '@kitties/api';
export const call=<A,E>(fn:(api:Effect.Success<typeof client>)=>Effect.Effect<A,E,HttpClient.HttpClient>)=>Effect.runPromise(Effect.gen(function*(){return yield* fn(yield* client);}).pipe(Effect.provide(FetchHttpClient.layer)));
