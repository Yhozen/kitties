import { expect, test } from "vitest";
import { ownerError } from "./security.ts";

const origin = "https://next.kitties.example";
const owner = "owner@example.org";
const identity = { email: owner };
const error = (request: Request, user: { email?: string } | undefined = identity) =>
  ownerError(request, origin, owner, user);

test("owner access requires native Access identity; spoofed email headers are insufficient", () => {
  const request = new Request(`${origin}/v1/session`, {
    headers: { "Cf-Access-Authenticated-User-Email": owner },
  });
  expect(ownerError(request, origin, owner, undefined)?.body.code).toBe("ACCESS_REQUIRED");
  expect(error(request, { email: "other@example.org" })?.body.code).toBe("ACCESS_DENIED");
  expect(error(request)).toBeUndefined();
});

test("mutations require the exact origin and same-origin fetch metadata", () => {
  const mutate = (headers: Record<string, string>) =>
    new Request(`${origin}/v1/kitties`, { method: "POST", headers });
  expect(error(mutate({}))?.body.code).toBe("ORIGIN_DENIED");
  expect(error(mutate({ Origin: "https://attacker.example" }))?.status).toBe(403);
  expect(error(mutate({ Origin: origin, "Sec-Fetch-Site": "cross-site" }))?.status).toBe(403);
  expect(error(mutate({ Origin: origin, "Sec-Fetch-Site": "same-origin" }))).toBeUndefined();
});

test("unexpected hostnames fail closed even with a valid owner identity", () => {
  expect(error(new Request("https://preview.workers.dev/v1/health"))?.status).toBe(404);
});
