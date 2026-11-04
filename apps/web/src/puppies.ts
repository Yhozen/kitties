// The puppies' avatars: soft, front-facing dog heads for the open-bot-avatar renderer (vendored
// in ./bot-avatar, with the Puppies skin extension), which infers their 3D volume and animates
// gaze, blinks and moods. The style follows a toy-like reference: a bun-shaped head, big ears set
// behind it, a pale muzzle, a small nose and a W-shaped smile, softly shaded.
//
// A puppy keeps two strings: `breed` picks the head and `color` the coat. The Shih Tzu in honey is
// the default. Older values (pixel-cat and cat breeds and coats) map onto the nearest puppy.
import type { AvatarDefinition, AvatarSkin } from "./bot-avatar/index.ts";

const puppy = (id: string, name: string, path: string, eyes: AvatarDefinition["eyes"]) =>
  ({ version: 1, id: `puppy-${id}`, name, body: { path }, eyes }) as const satisfies AvatarDefinition;

// Where a coat's colors go: the head, the ears and markings, the muzzle, a mask, the eyes and nose.
type Role = "body" | "accent" | "light" | "dark" | "ink";

interface Puppy {
  definition: AvatarDefinition;
  // Per subpath (head first, then ears and puffs): its coat role and its shift along depth.
  parts: Role[];
  offsets: number[];
  // Painted on the head: muzzle, nose, smile, markings.
  decals: { d: string; fill?: Role; stroke?: Role; width?: number }[];
}

// Each definition passes `avatar-validate.ts --strict` (face room and seams), see puppies.test.ts.
export const PUPPIES = {
  "shih-tzu": {
    definition: puppy(
      "shih-tzu",
      "Shih Tzu",
      "M50 25.32C59.31 25.32 67.18 30.84 70.7 40.96C77.6 49.24 78.98 57.52 78.52 64.88C78.06 73.16 71.62 78.68 61.04 79.6C54.6 80.15 45.4 80.15 38.96 79.6C28.38 78.68 21.94 73.16 21.48 64.88C21.02 57.52 22.4 49.24 29.3 40.96C32.82 30.84 40.69 25.32 50 25.32ZM37.12 25.78C41.72 25.32 43.56 29 42.18 33.6C39.88 40.96 34.36 51.08 29.76 59.36C27 64.88 23.32 69.94 18.72 69.48C13.66 69.02 10.9 63.04 11.36 55.68C11.82 47.4 15.96 39.12 22.4 32.68C27 28.08 32.52 25.78 37.12 25.78ZM62.88 25.78C67.48 25.78 73 28.08 77.6 32.68C84.04 39.12 88.18 47.4 88.64 55.68C89.1 63.04 86.34 69.02 81.28 69.48C76.68 69.94 73 64.88 70.24 59.36C65.64 51.08 60.12 40.96 57.82 33.6C56.44 29 58.28 25.32 62.88 25.78Z",
      { x: 50, y: 51.26, spacing: 23.64, scale: 0.82 },
    ),
    parts: ["body", "accent", "accent"],
    offsets: [0, -7, -7],
    decals: [
      { d: "M32.06 67.18A17.94 11.96 0 0 1 67.94 67.18A17.94 11.96 0 0 1 32.06 67.18Z", fill: "light" },
      { d: "M46.69 56.42C46.69 55.13 48.34 54.94 50 54.94C51.66 54.94 53.31 55.13 53.31 56.42C53.31 58.26 51.38 59.64 50 59.64C48.62 59.64 46.69 58.26 46.69 56.42Z", fill: "ink" },
      { d: "M44.66 64.14Q46.04 66.44 47.79 66.17Q49.36 65.89 50 64.24Q50.64 65.89 52.21 66.17Q53.96 66.44 55.34 64.14", stroke: "ink", width: 1.15 },
    ],
  },
  beagle: {
    definition: puppy(
      "beagle",
      "Beagle",
      "M50 26.24C60.35 26.24 69.09 31.76 73 41.88C75.3 50.16 76.68 58.44 76.22 65.8C75.76 73.16 69.32 78.68 61.04 79.6C54.6 80.15 45.4 80.15 38.96 79.6C30.68 78.68 24.24 73.16 23.78 65.8C23.32 58.44 24.7 50.16 27 41.88C30.91 31.76 39.65 26.24 50 26.24ZM35.28 29C39.42 28.08 41.72 31.3 40.8 36.36C39.42 46.48 37.58 57.52 34.36 66.72C32.06 73.16 27.46 77.76 21.94 75.92C16.42 74.08 15.96 65.8 17.34 57.52C19.18 45.56 25.16 30.84 35.28 29ZM64.72 29C74.84 30.84 80.82 45.56 82.66 57.52C84.04 65.8 83.58 74.08 78.06 75.92C72.54 77.76 67.94 73.16 65.64 66.72C62.42 57.52 60.58 46.48 59.2 36.36C58.28 31.3 60.58 28.08 64.72 29Z",
      { x: 50, y: 51.26, spacing: 22.08, scale: 0.75 },
    ),
    parts: ["body", "accent", "accent"],
    offsets: [0, -7, -7],
    decals: [
      { d: "M46.78 28.08C48.16 26.79 51.84 26.79 53.22 28.08C54.6 34.52 54.6 45.56 56.44 55.68L43.56 55.68C45.4 45.56 45.4 34.52 46.78 28.08Z", fill: "light" },
      { d: "M33.9 66.72A16.1 11.96 0 0 1 66.1 66.72A16.1 11.96 0 0 1 33.9 66.72Z", fill: "light" },
      { d: "M46.69 56.42C46.69 55.13 48.34 54.94 50 54.94C51.66 54.94 53.31 55.13 53.31 56.42C53.31 58.26 51.38 59.64 50 59.64C48.62 59.64 46.69 58.26 46.69 56.42Z", fill: "ink" },
      { d: "M44.66 64.14Q46.04 66.44 47.79 66.17Q49.36 65.89 50 64.24Q50.64 65.89 52.21 66.17Q53.96 66.44 55.34 64.14", stroke: "ink", width: 1.15 },
    ],
  },
  corgi: {
    definition: puppy(
      "corgi",
      "Corgi",
      "M50 28.08C61.18 28.08 70.62 33.6 74.84 43.72C78.52 52 79.9 60.28 79.44 67.64C78.98 73.16 72.54 78.68 61.04 79.6C54.6 80.15 45.4 80.15 38.96 79.6C27.46 78.68 21.02 73.16 20.56 67.64C20.1 60.28 21.48 52 25.16 43.72C29.38 33.6 38.82 28.08 50 28.08ZM27 45.56C24.24 36.36 21.94 24.4 22.4 17.04C22.68 12.44 26.54 11.06 29.76 13.82C35.28 18.42 39.88 23.48 43.56 29.46ZM56.44 29.46C60.12 23.48 64.72 18.42 70.24 13.82C73.46 11.06 77.32 12.44 77.6 17.04C78.06 24.4 75.76 36.36 73 45.56Z",
      { x: 50, y: 52, spacing: 23.64, scale: 0.75 },
    ),
    parts: ["body", "body", "body"],
    offsets: [0, -7, -7],
    decals: [
      { d: "M47.7 35.44C48.62 34.15 51.38 34.15 52.3 35.44C53.22 40.96 53.68 47.4 55.52 55.68L44.48 55.68C46.32 47.4 46.78 40.96 47.7 35.44Z", fill: "light" },
      { d: "M30.68 67.64A19.32 12.42 0 0 1 69.32 67.64A19.32 12.42 0 0 1 30.68 67.64Z", fill: "light" },
      { d: "M46.69 56.42C46.69 55.13 48.34 54.94 50 54.94C51.66 54.94 53.31 55.13 53.31 56.42C53.31 58.26 51.38 59.64 50 59.64C48.62 59.64 46.69 58.26 46.69 56.42Z", fill: "ink" },
      { d: "M44.66 64.14Q46.04 66.44 47.79 66.17Q49.36 65.89 50 64.24Q50.64 65.89 52.21 66.17Q53.96 66.44 55.34 64.14", stroke: "ink", width: 1.15 },
    ],
  },
  poodle: {
    definition: puppy(
      "poodle",
      "Poodle",
      "M50 29C59.94 29 68.33 34.52 72.08 44.64C74.38 52.92 75.76 61.2 75.3 68.56C74.84 73.16 68.4 78.68 61.04 79.6C54.6 80.15 45.4 80.15 38.96 79.6C31.6 78.68 25.16 73.16 24.7 68.56C24.24 61.2 25.62 52.92 27.92 44.64C31.67 34.52 40.06 29 50 29ZM36.2 27.16A13.8 10.12 0 0 1 63.8 27.16A13.8 10.12 0 0 1 36.2 27.16ZM23.32 44.64C27.92 40.96 33.44 43.72 34.36 50.16C35.28 56.6 33.44 63.96 30.68 68.56C27.92 73.16 21.48 74.08 18.26 70.4C15.04 66.72 15.5 60.28 16.42 54.76C17.34 50.16 19.64 46.94 23.32 44.64ZM76.68 44.64C80.36 46.94 82.66 50.16 83.58 54.76C84.5 60.28 84.96 66.72 81.74 70.4C78.52 74.08 72.08 73.16 69.32 68.56C66.56 63.96 64.72 56.6 65.64 50.16C66.56 43.72 72.08 40.96 76.68 44.64Z",
      { x: 50, y: 51.26, spacing: 21.16, scale: 0.75 },
    ),
    parts: ["body", "body", "body", "body"],
    offsets: [0, -7, -7, -7],
    decals: [
      { d: "M35.28 67.64A14.72 11.04 0 0 1 64.72 67.64A14.72 11.04 0 0 1 35.28 67.64Z", fill: "light" },
      { d: "M46.69 56.42C46.69 55.13 48.34 54.94 50 54.94C51.66 54.94 53.31 55.13 53.31 56.42C53.31 58.26 51.38 59.64 50 59.64C48.62 59.64 46.69 58.26 46.69 56.42Z", fill: "ink" },
      { d: "M44.66 64.14Q46.04 66.44 47.79 66.17Q49.36 65.89 50 64.24Q50.64 65.89 52.21 66.17Q53.96 66.44 55.34 64.14", stroke: "ink", width: 1.15 },
    ],
  },
  pug: {
    definition: puppy(
      "pug",
      "Pug",
      "M50 27.16C61.38 27.16 71 32.68 75.3 42.8C78.06 51.08 79.44 59.36 78.98 66.72C78.52 73.16 72.08 78.68 61.04 79.6C54.6 80.15 45.4 80.15 38.96 79.6C27.92 78.68 21.48 73.16 21.02 66.72C20.56 59.36 21.94 51.08 24.7 42.8C29 32.68 38.62 27.16 50 27.16ZM29.76 27.16C34.36 24.86 39.88 26.24 40.8 30.38C37.58 35.9 31.6 40.5 24.7 42.34C20.1 43.54 16.88 40.5 18.26 36.36C20.1 31.76 24.7 29 29.76 27.16ZM70.24 27.16C75.3 29 79.9 31.76 81.74 36.36C83.12 40.5 79.9 43.54 75.3 42.34C68.4 40.5 62.42 35.9 59.2 30.38C60.12 26.24 65.64 24.86 70.24 27.16Z",
      { x: 50, y: 51.26, spacing: 24.84, scale: 0.8 },
    ),
    parts: ["body", "dark", "dark"],
    offsets: [0, -7, -7],
    decals: [
      { d: "M34.36 65.8A15.64 12.88 0 0 1 65.64 65.8A15.64 12.88 0 0 1 34.36 65.8Z", fill: "dark" },
      { d: "M46.69 56.42C46.69 55.13 48.34 54.94 50 54.94C51.66 54.94 53.31 55.13 53.31 56.42C53.31 58.26 51.38 59.64 50 59.64C48.62 59.64 46.69 58.26 46.69 56.42Z", fill: "ink" },
    ],
  },
  dalmatian: {
    definition: puppy(
      "dalmatian",
      "Dalmatian",
      "M50 25.32C60.97 25.32 70.24 30.84 74.38 40.96C77.6 49.24 78.98 57.52 78.52 64.88C78.06 73.16 71.62 78.68 61.04 79.6C54.6 80.15 45.4 80.15 38.96 79.6C28.38 78.68 21.94 73.16 21.48 64.88C21.02 57.52 22.4 49.24 25.62 40.96C29.76 30.84 39.03 25.32 50 25.32ZM36.2 27.16C39.88 26.24 41.72 29.46 40.34 33.6C38.04 40.96 34.36 49.24 30.68 55.68C27.92 60.74 23.32 63.5 19.18 61.66C14.58 59.36 13.66 52 15.5 45.56C18.26 36.36 27 28.54 36.2 27.16ZM63.8 27.16C73 28.54 81.74 36.36 84.5 45.56C86.34 52 85.42 59.36 80.82 61.66C76.68 63.5 72.08 60.74 69.32 55.68C65.64 49.24 61.96 40.96 59.66 33.6C58.28 29.46 60.12 26.24 63.8 27.16Z",
      { x: 50, y: 51.26, spacing: 23.64, scale: 0.75 },
    ),
    parts: ["body", "accent", "accent"],
    offsets: [0, -7, -7],
    decals: [
      { d: "M34.36 35.44A3.68 2.94 0 0 1 41.72 35.44A3.68 2.94 0 0 1 34.36 35.44Z", fill: "accent" },
      { d: "M56.62 32.68A2.58 2.12 0 0 1 61.78 32.68A2.58 2.12 0 0 1 56.62 32.68Z", fill: "accent" },
      { d: "M64.35 41.88A3.13 2.58 0 0 1 70.61 41.88A3.13 2.58 0 0 1 64.35 41.88Z", fill: "accent" },
      { d: "M26.45 59.36A2.39 2.02 0 0 1 31.23 59.36A2.39 2.02 0 0 1 26.45 59.36Z", fill: "accent" },
      { d: "M67.48 62.12A2.76 2.3 0 0 1 73 62.12A2.76 2.3 0 0 1 67.48 62.12Z", fill: "accent" },
      { d: "M46.69 56.42C46.69 55.13 48.34 54.94 50 54.94C51.66 54.94 53.31 55.13 53.31 56.42C53.31 58.26 51.38 59.64 50 59.64C48.62 59.64 46.69 58.26 46.69 56.42Z", fill: "ink" },
      { d: "M44.66 64.14Q46.04 66.44 47.79 66.17Q49.36 65.89 50 64.24Q50.64 65.89 52.21 66.17Q53.96 66.44 55.34 64.14", stroke: "ink", width: 1.15 },
    ],
  },
} satisfies Record<string, Puppy>;

export type Breed = keyof typeof PUPPIES;
export const BREEDS = Object.keys(PUPPIES) as Breed[];
export const DEFAULT_BREED: Breed = "shih-tzu";

// Coats: a color for each role. Honey is the reference's warm cream with caramel ears.
export const COATS = {
  honey: { label: "Honey", body: "#f4cfa0", accent: "#e2a064", light: "#fbe7cb", dark: "#5b3a26", ink: "#3d2116" },
  cream: { label: "Cream", body: "#f7e6cc", accent: "#e8c48f", light: "#fff6e8", dark: "#4a3526", ink: "#3d2a18" },
  caramel: { label: "Caramel", body: "#dc9d5e", accent: "#b46f34", light: "#f6dcb8", dark: "#4a2a14", ink: "#2e170b" },
  chocolate: { label: "Chocolate", body: "#8e5a3a", accent: "#6a3f26", light: "#d6aa86", dark: "#3a2214", ink: "#1e0f07" },
  white: { label: "White", body: "#f6f3ee", accent: "#3a3a44", light: "#ffffff", dark: "#2a2a32", ink: "#24242c" },
  gray: { label: "Gray", body: "#c4c6d0", accent: "#7d8090", light: "#eceef3", dark: "#3a3b45", ink: "#23242e" },
  black: { label: "Black", body: "#4a4a56", accent: "#2f2f38", light: "#a9a9b8", dark: "#24242c", ink: "#121218" },
  rose: { label: "Rose", body: "#f6c3d2", accent: "#e58fab", light: "#fde6ee", dark: "#6b3045", ink: "#3a1724" },
  lavender: { label: "Lavender", body: "#d6c6f0", accent: "#a98bdc", light: "#f0e9fb", dark: "#43305f", ink: "#251a38" },
  blue: { label: "Blue", body: "#bcd2ec", accent: "#7fa2c9", light: "#e8f0fa", dark: "#2c4260", ink: "#16223a" },
  mint: { label: "Mint", body: "#bfe8d4", accent: "#7fd6b0", light: "#e8f8f0", dark: "#285a44", ink: "#15302a" },
} as const;

export type Coat = keyof typeof COATS;
export const COLORS = Object.keys(COATS) as Coat[];
export const DEFAULT_COAT: Coat = "honey";

// skinOf paints a breed in a coat: part colors, rim shading, the face decals, oval eyes with a shine.
export function skinOf(breed: Breed, coat: Coat): AvatarSkin {
  const p: Puppy = PUPPIES[breed], c = COATS[coat];
  return {
    parts: p.parts.map((role) => c[role]),
    offsets: p.offsets,
    shade: 0.22,
    eyeWidth: 2,
    eyeShine: "#ffffff",
    decals: p.decals.map((d) => ({
      d: d.d,
      ...(d.fill ? { fill: c[d.fill] } : {}),
      ...(d.stroke ? { stroke: c[d.stroke], width: d.width } : {}),
    })),
  };
}

// Cat avatars (and the pixel cats before them) map onto the closest puppy.
const LEGACY_BREEDS: Record<string, Breed> = {
  sitting: "shih-tzu",
  tabby: "shih-tzu",
  shorthair: "shih-tzu",
  box: "shih-tzu",
  kitten: "beagle",
  black: "beagle",
  chonk: "pug",
  tuxedo: "pug",
  fluffy: "poodle",
  lynx: "corgi",
  siamese: "corgi",
  loaf: "dalmatian",
  calico: "dalmatian",
};
const LEGACY_COLORS: Record<string, Coat> = {
  orange: "caramel",
  peach: "honey",
  brown: "chocolate",
  pink: "rose",
  lilac: "lavender",
};

const own = <T>(table: Record<string, T>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

// breedOf and coatOf read what a puppy stored, old values included; anything else is the default.
export function breedOf(value: string | undefined): Breed {
  return own(PUPPIES, value) ? (value as Breed) : (own(LEGACY_BREEDS, value) ?? DEFAULT_BREED);
}

export function coatOf(value: string | undefined): Coat {
  return own(COATS, value) ? (value as Coat) : (own(LEGACY_COLORS, value) ?? DEFAULT_COAT);
}
