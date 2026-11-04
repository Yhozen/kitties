import { expect, test } from "vitest";
import { analyzeBody, validateAvatar } from "./bot-avatar/validate.ts";
import { faceRoom } from "./bot-avatar/volume.ts";
import { silhouetteSeams } from "./bot-avatar/seams.ts";
import { renderAvatarSvg } from "./bot-avatar/render.ts";
import { BREEDS, COLORS, PUPPIES, breedOf, coatOf, skinOf } from "./puppies.ts";

test.each(BREEDS)("the %s puppy meets the renderer's strict design targets", (breed) => {
  const { definition, parts, offsets } = PUPPIES[breed];
  const result = validateAvatar(definition);
  expect(result.ok ? [] : result.errors).toEqual([]);
  const body = analyzeBody(definition.body.path);
  expect(faceRoom(definition, body).ok).toBe(true);
  expect(silhouetteSeams(body.polys)).toEqual([]);
  // One coat role and one depth shift per part, the head (which carries the face) first.
  const outlines = body.subpaths.filter((s) => !s.hole).length;
  expect([parts.length, offsets.length, offsets[0]]).toEqual([outlines, outlines, 0]);
});

test.each(BREEDS)("the %s puppy paints every coat in a still image", (breed) => {
  for (const coat of COLORS) {
    const svg = renderAvatarSvg(PUPPIES[breed].definition, { reducedMotion: true, skin: skinOf(breed, coat) });
    expect(svg).toContain("<mask");
    expect(svg).not.toContain("undefined");
  }
});

test("stored cat breeds and coats map onto puppies; the Shih Tzu in honey is the default", () => {
  expect([breedOf("tabby"), breedOf("loaf"), breedOf("pug"), breedOf(undefined), breedOf("constructor")]).toEqual(["shih-tzu", "dalmatian", "pug", "shih-tzu", "shih-tzu"]);
  expect([coatOf("orange"), coatOf("lilac"), coatOf("black"), coatOf(""), coatOf("toString")]).toEqual(["caramel", "lavender", "black", "honey", "honey"]);
});
