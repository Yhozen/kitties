import { expect, test } from "vitest";
import { analyzeBody, validateAvatar } from "./bot-avatar/validate.ts";
import { faceRoom } from "./bot-avatar/volume.ts";
import { silhouetteSeams } from "./bot-avatar/seams.ts";
import { BREEDS, CATS, breedOf, coatOf } from "./cats.ts";

test.each(BREEDS)("the %s cat meets the renderer's strict design targets", (breed) => {
  const result = validateAvatar(CATS[breed]);
  expect(result.ok ? [] : result.errors).toEqual([]);
  const body = analyzeBody(CATS[breed].body.path);
  expect(faceRoom(CATS[breed], body).ok).toBe(true);
  expect(silhouetteSeams(body.polys)).toEqual([]);
});

test("stored breeds and coats from the pixel cats map onto the new avatars", () => {
  expect([breedOf("tabby"), breedOf("siamese"), breedOf("loaf"), breedOf(undefined), breedOf("constructor")]).toEqual(["sitting", "lynx", "loaf", "sitting", "sitting"]);
  expect([coatOf("lilac"), coatOf("black"), coatOf(""), coatOf("toString")]).toEqual(["lavender", "black", "mint", "mint"]);
});
