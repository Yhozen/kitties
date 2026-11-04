// The kitties' avatars: cat silhouettes for the open-bot-avatar renderer (vendored in
// ./bot-avatar), which infers their 3D volume and animates gaze, blinks and moods.
//
// A kitty keeps two strings: `breed` picks the silhouette and `color` the coat. Older kitties
// stored pixel-cat breeds and coats; they map onto the nearest variation here.
import type { AvatarDefinition } from "./bot-avatar/index.ts";

const cat = (id: string, name: string, path: string, eyes: AvatarDefinition["eyes"]) =>
  ({ version: 1, id: `cat-${id}`, name, body: { path }, eyes }) as const satisfies AvatarDefinition;

// Each passes `avatar-validate.ts --strict` (face room and seams), see cats.test.ts.
export const CATS = {
  sitting: cat(
    "sitting",
    "Sitting",
    "M50 23C68 23 82 30 82 45C82 58 68 65 50 65C32 65 18 58 18 45C18 30 32 23 50 23ZM24 42C21 32 20 22 22 15C23 11 26 10 29 12C34 16 39 21 44 28L36 42ZM64 42L56 28C61 21 66 16 71 12C74 10 77 11 78 15C80 22 79 32 76 42ZM38 56L62 56C70 56 74 66 74 76C74 83 70 86 63 86L37 86C30 86 26 83 26 76C26 66 30 56 38 56ZM70 72C77 74 81 70 80 64C79 60 81 57 84 58C87 59 88.5 63 88 68C87 77 80 83 70 81Z",
    { x: 50, y: 43, spacing: 17, scale: 1.1 },
  ),
  kitten: cat(
    "kitten",
    "Kitten",
    "M19 44A31 25 0 0 1 81 44A31 25 0 0 1 19 44ZM22 38L23.6 15Q24 10 27.9 13.1L42 24ZM58 24L72.1 13.1Q76 10 76.4 15L78 38ZM48 58H52A13 13 0 0 1 65 71V73A13 13 0 0 1 52 86H48A13 13 0 0 1 35 73V71A13 13 0 0 1 48 58ZM62 80C72 82 79 77 79 70C79 66 81 64 83 64.5C86 65 86.5 69 86 72C84.5 81 76 87 63 86Z",
    { x: 50, y: 46, spacing: 19, scale: 1.3 },
  ),
  chonk: cat(
    "chonk",
    "Chonk",
    "M14 56A36 30 0 0 1 86 56A36 30 0 0 1 14 56ZM20 46L21.7 19Q22 14 26 16.9L44 30ZM56 30L74 16.9Q78 14 78.3 19L80 46ZM78 74C86 76 91 70 90 62C89.5 58 91 55.5 88 55C84 54.5 83 58 83.5 62C84 66 82 68 78 68Z",
    { x: 50, y: 53, spacing: 19, scale: 1.2 },
  ),
  loaf: cat(
    "loaf",
    "Loaf",
    "M46 50H74A16 16 0 0 1 90 66V70A16 16 0 0 1 74 86H46A16 16 0 0 1 30 70V66A16 16 0 0 1 46 50ZM12 50A24 21 0 0 1 60 50A24 21 0 0 1 12 50ZM14 44L14.9 20Q15 16 17.8 18.8L30 31ZM42 30L52.1 20.7Q55 18 55.5 22L58 44Z",
    { x: 36, y: 51, spacing: 15, scale: 1.05 },
  ),
  fluffy: cat(
    "fluffy",
    "Fluffy",
    "M21 45A29 24 0 0 1 79 45Q83.3 52.4 74.4 56.6Q74.4 65.2 64.1 65.2Q58.9 72.5 50 68.3Q41.1 72.5 35.9 65.2Q25.6 65.2 25.6 56.6Q16.7 52.4 21 45ZM25 38L24.2 15.5Q24 11 27.6 13.7L44 26ZM56 26L72.4 13.7Q76 11 75.8 15.5L75 38ZM38 62H62C69 62 73 72 73 79C73 84 69 87 63 87H37C31 87 27 84 27 79C27 72 31 62 38 62ZM66 86C80 88 91 80 91 66C91 57 88 50 83 49C78 48 75 52 76 57C77 62 80 66 79 71C78 76 73 78 66 77Z",
    { x: 50, y: 44, spacing: 18, scale: 1.15 },
  ),
  lynx: cat(
    "lynx",
    "Lynx",
    "M24 45A26 21 0 0 1 76 45A26 21 0 0 1 24 45ZM27 40L26.1 10.5Q26 8 27.7 9.9L43 27ZM57 27L72.3 9.9Q74 8 73.9 10.5L73 40ZM36 63L20.4 58.9Q17 58 18.9 55.1L27 43ZM73 43L81.1 55.1Q83 58 79.6 58.9L64 63ZM40 58C46 57 54 57 60 58C67 60 71 72 71 80C71 85 67 88 61 88H39C33 88 29 85 29 80C29 72 33 60 40 58ZM66 74C72 71 78 72 80 76C82 80 79 84 74 85C70 85.5 67 84 66 82Z",
    { x: 50, y: 45, spacing: 16, scale: 1.1 },
  ),
  box: cat(
    "box",
    "Box",
    "M22 48A28 22 0 0 1 78 48A28 22 0 0 1 22 48ZM25 43L25 17.5Q25 13 28.4 16L43 29ZM57 29L71.6 16Q75 13 75 17.5L75 43ZM18 64L10 55.5Q8 53.5 10.5 51.5L13.5 49Q16 47 18 49L34 64H66L81 49.5Q83 47.5 85.5 49.5L89.5 53Q91.5 55 89.5 57L82 64V84Q82 88 78 88H22Q18 88 18 84Z",
    { x: 50, y: 46, spacing: 18, scale: 1.15 },
  ),
} satisfies Record<string, AvatarDefinition>;

export type Breed = keyof typeof CATS;
export const BREEDS = Object.keys(CATS) as Breed[];

// Coats: the body color and an eye color that reads on it.
export const COATS = {
  mint: { body: "#7fd6b0", eyes: "#15201b", label: "Mint" },
  peach: { body: "#f7b58c", eyes: "#2a1810", label: "Peach" },
  orange: { body: "#f39a3b", eyes: "#2a1505", label: "Orange" },
  cream: { body: "#f1d9a8", eyes: "#2a2010", label: "Cream" },
  rose: { body: "#f19bb5", eyes: "#2a1018", label: "Rose" },
  lavender: { body: "#b79ddf", eyes: "#1c1530", label: "Lavender" },
  blue: { body: "#7fa2c9", eyes: "#101a2a", label: "Blue" },
  gray: { body: "#8d8fa0", eyes: "#f6e27a", label: "Gray" },
  brown: { body: "#8b5a3c", eyes: "#ffe2a8", label: "Brown" },
  black: { body: "#40404e", eyes: "#ffd34d", label: "Black" },
} as const;

export type Coat = keyof typeof COATS;
export const COLORS = Object.keys(COATS) as Coat[];

const LEGACY_BREEDS: Record<string, Breed> = {
  tabby: "sitting",
  shorthair: "sitting",
  tuxedo: "chonk",
  calico: "loaf",
  siamese: "lynx",
  black: "kitten",
};
const LEGACY_COLORS: Record<string, Coat> = { pink: "rose", lilac: "lavender", white: "cream" };

const own = <T>(table: Record<string, T>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

// breedOf and coatOf read what a kitty stored, old values included; anything else is the default.
export function breedOf(value: string | undefined): Breed {
  return own(CATS, value) ? (value as Breed) : (own(LEGACY_BREEDS, value) ?? "sitting");
}

export function coatOf(value: string | undefined): Coat {
  return own(COATS, value) ? (value as Coat) : (own(LEGACY_COLORS, value) ?? "mint");
}
