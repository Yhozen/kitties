// A pixel cat: the avatar of a kitty. Five breeds (shape and markings), ten coats, and a set of
// moods it animates through as a bot would: idle (blinks, swishes its tail), thinking (looks
// up, dots above), talking (mouth moves), working (narrow eyes, busy paws), happy (closed
// smiling eyes, a bounce), error (crossed eyes, a shake) and sleeping (closed eyes, a slow
// breath and a floating z).
//
// Everything is drawn from 16x16 grids of palette indices, rendered as SVG rects with crisp
// edges, so it scales from a 20px row icon to a 160px portrait without blur.
import { useEffect, useState } from "preact/hooks";

export type Mood = "idle" | "thinking" | "talking" | "working" | "happy" | "error" | "sleeping";
export const MOODS: Mood[] = [
  "idle",
  "thinking",
  "talking",
  "working",
  "happy",
  "error",
  "sleeping",
];
export const BREEDS = ["tabby", "shorthair", "tuxedo", "fluffy", "siamese"] as const;
export type Breed = (typeof BREEDS)[number];

// Each coat: body, a darker shade (outline, stripes) and a lighter one (belly, muzzle).
export const COATS: Record<string, { body: string; dark: string; light: string; label: string }> = {
  orange: { body: "#f39a3b", dark: "#9a4f12", light: "#fbd7a5", label: "Orange" },
  gray: { body: "#8d8fa0", dark: "#44465a", light: "#d4d5e0", label: "Gray" },
  black: { body: "#3b3b48", dark: "#15151c", light: "#6b6b80", label: "Black" },
  white: { body: "#f4f1ec", dark: "#a8a39b", light: "#ffffff", label: "White" },
  cream: { body: "#f1d9a8", dark: "#a98448", light: "#fbf0d8", label: "Cream" },
  brown: { body: "#8b5a3c", dark: "#4a2d1c", light: "#c99a7a", label: "Brown" },
  blue: { body: "#7fa2c9", dark: "#36507a", light: "#c6d8ee", label: "Blue" },
  pink: { body: "#f1a0c2", dark: "#a34b73", light: "#fbd6e5", label: "Pink" },
  mint: { body: "#8fd6b4", dark: "#3b8664", light: "#d2f1e2", label: "Mint" },
  lilac: { body: "#b79ddf", dark: "#6a4aa3", light: "#e2d4f5", label: "Lilac" },
};
export const COLORS = Object.keys(COATS);

// Palette indices used in the grids.
const _ = 0; // transparent
const O = 1; // outline / dark
const B = 2; // body
const L = 3; // light (belly, muzzle, white parts)
const E = 4; // eye
const N = 5; // nose / inner ear
const W = 6; // eye white / sparkle
const S = 7; // stripe (dark shade on the body)
const K = 8; // collar / accent

type Grid = number[][];

// The base cat, facing the reader, with its tail on the right. Rows 5-8 hold the face, which the
// moods redraw.
const BASE: Grid = [
  [_, _, _, O, _, _, _, _, _, _, _, _, O, _, _, _],
  [_, _, O, B, O, _, _, _, _, _, _, O, B, O, _, _],
  [_, _, O, B, N, O, O, O, O, O, O, N, B, O, _, _],
  [_, _, O, B, B, B, B, B, B, B, B, B, B, O, _, _],
  [_, O, B, B, B, B, B, B, B, B, B, B, B, B, O, _],
  [_, O, B, B, E, E, B, B, B, B, E, E, B, B, O, _],
  [_, O, B, B, E, W, B, B, B, B, E, W, B, B, O, _],
  [_, O, B, B, B, B, L, N, N, L, B, B, B, B, O, _],
  [_, O, B, B, B, B, L, L, L, L, B, B, B, B, O, _],
  [_, _, O, B, B, B, B, B, B, B, B, B, B, O, _, _],
  [_, _, O, B, B, B, B, B, B, B, B, B, B, O, _, _],
  [_, O, B, B, B, B, L, L, L, L, B, B, B, B, O, O],
  [_, O, B, B, B, B, L, L, L, L, B, B, B, B, O, B, O],
  [_, O, B, B, B, B, B, L, L, B, B, B, B, B, O, B, O],
  [_, O, B, B, O, B, B, B, B, B, B, O, B, B, O, O, _],
  [_, _, O, O, _, O, O, O, O, O, O, _, O, O, _, _, _],
];

function clone(g: Grid): Grid {
  return g.map((r) => r.slice());
}

function set(g: Grid, y: number, x: number, v: number) {
  if (g[y] && x >= 0 && x < 17) {
    g[y][x] = v;
  }
}

// Breed markings over the base.
function markings(g: Grid, breed: Breed) {
  switch (breed) {
    case "tabby":
      for (const x of [5, 7, 9, 11]) {
        set(g, 3, x, S);
        set(g, 4, x + (x === 11 ? -1 : 0), S);
      }
      set(g, 2, 7, S);
      set(g, 2, 8, S);
      for (const x of [3, 6, 11]) {
        set(g, 10, x, S);
      }
      set(g, 12, 15, S);
      break;
    case "tuxedo":
      // A white bib, white paws and a white blaze on the muzzle.
      for (let y = 9; y <= 13; y++) {
        for (let x = 6; x <= 9; x++) {
          set(g, y, x, L);
        }
      }
      set(g, 14, 2, L);
      set(g, 14, 3, L);
      set(g, 14, 12, L);
      set(g, 14, 13, L);
      set(g, 4, 7, L);
      set(g, 4, 8, L);
      set(g, 9, 5, L);
      set(g, 9, 10, L);
      break;
    case "fluffy":
      // Tufted ears, fluffy cheeks and a big bushy tail.
      set(g, 0, 2, O);
      set(g, 0, 13, O);
      set(g, 1, 1, O);
      set(g, 1, 14, O);
      set(g, 6, 0, O);
      set(g, 7, 0, O);
      set(g, 6, 15, O);
      set(g, 7, 15, O);
      set(g, 6, 1, B);
      set(g, 7, 1, B);
      set(g, 6, 14, B);
      set(g, 7, 14, B);
      set(g, 10, 15, O);
      set(g, 10, 16, _);
      set(g, 11, 16, O);
      set(g, 12, 16, O);
      set(g, 11, 15, B);
      set(g, 13, 16, O);
      set(g, 13, 15, B);
      set(g, 14, 15, B);
      set(g, 14, 16, O);
      set(g, 15, 15, O);
      break;
    case "siamese":
      // Dark points: ears, mask, paws and tail; a cream body.
      for (const [y, x] of [
        [1, 3],
        [1, 12],
        [2, 3],
        [2, 12],
      ]) {
        set(g, y, x, S);
      }
      for (let x = 5; x <= 10; x++) {
        set(g, 7, x, g[7][x] === L ? L : S);
        set(g, 8, x, g[8][x] === L ? L : S);
      }
      for (const x of [2, 3, 12, 13]) {
        set(g, 14, x, S);
      }
      set(g, 12, 15, S);
      set(g, 13, 15, S);
      break;
    default:
      // shorthair: a plain coat with a collar.
      for (let x = 3; x <= 12; x++) {
        set(g, 9, x, K);
      }
      set(g, 10, 7, W);
      set(g, 10, 8, W);
  }
}

// Faces by mood (and frame). They redraw rows 5-8 of the face area.
function face(g: Grid, mood: Mood, frame: number) {
  const eyesOpen = () => {
    set(g, 5, 4, E);
    set(g, 5, 5, E);
    set(g, 6, 4, E);
    set(g, 6, 5, W);
    set(g, 5, 10, E);
    set(g, 5, 11, E);
    set(g, 6, 10, E);
    set(g, 6, 11, W);
  };
  const eyesClosed = (y = 6) => {
    for (const x of [4, 5, 10, 11]) {
      set(g, 5, x, B);
      set(g, 6, x, B);
    }
    set(g, y, 4, O);
    set(g, y, 5, O);
    set(g, y, 10, O);
    set(g, y, 11, O);
  };
  const clearEyes = () => {
    for (const x of [4, 5, 10, 11]) {
      set(g, 5, x, B);
      set(g, 6, x, B);
    }
  };
  const mouthOpen = () => {
    set(g, 8, 7, O);
    set(g, 8, 8, O);
  };
  const smile = () => {
    set(g, 8, 6, O);
    set(g, 8, 9, O);
  };
  switch (mood) {
    case "idle":
      if (frame % 6 === 5) {
        eyesClosed();
      } else {
        eyesOpen();
      }
      break;
    case "thinking":
      clearEyes();
      // Eyes up and to the side.
      set(g, 5, 5, E);
      set(g, 5, 6, E);
      set(g, 5, 11, E);
      set(g, 5, 12, E);
      set(g, 8, 7, O);
      break;
    case "talking":
      eyesOpen();
      if (frame % 2 === 0) {
        mouthOpen();
      } else {
        smile();
      }
      break;
    case "working":
      clearEyes();
      // Narrow, focused eyes.
      set(g, 6, 4, E);
      set(g, 6, 5, E);
      set(g, 6, 10, E);
      set(g, 6, 11, E);
      set(g, 8, 7, O);
      set(g, 8, 8, O);
      // Busy paws, left and right in turn.
      if (frame % 2 === 0) {
        set(g, 13, 4, O);
      } else {
        set(g, 13, 11, O);
      }
      break;
    case "happy":
      clearEyes();
      // ^ ^ eyes.
      set(g, 5, 4, O);
      set(g, 6, 3, O);
      set(g, 6, 5, O);
      set(g, 5, 11, O);
      set(g, 6, 10, O);
      set(g, 6, 12, O);
      smile();
      // Blushing cheeks.
      set(g, 7, 3, N);
      set(g, 7, 12, N);
      break;
    case "error":
      clearEyes();
      // X X eyes.
      set(g, 5, 4, O);
      set(g, 6, 5, O);
      set(g, 5, 5, O);
      set(g, 6, 4, O);
      set(g, 5, 10, O);
      set(g, 6, 11, O);
      set(g, 5, 11, O);
      set(g, 6, 10, O);
      set(g, 8, 6, O);
      set(g, 8, 9, O);
      set(g, 9, 7, O);
      set(g, 9, 8, O);
      break;
    case "sleeping":
      eyesClosed(6);
      set(g, 8, 7, O);
      break;
  }
}

export function grid(breed: Breed, mood: Mood, frame: number): Grid {
  const g = clone(BASE);
  markings(g, breed);
  face(g, mood, frame);
  return g;
}

function paint(index: number, coat: (typeof COATS)[string], breed: Breed, color: string): string {
  switch (index) {
    case O:
      return coat.dark;
    case B:
      return breed === "siamese" ? "#f3e6cf" : coat.body;
    case L:
      return breed === "tuxedo" || breed === "siamese" ? "#fbf8f2" : coat.light;
    case E:
      return breed === "siamese" || color === "white" ? "#3b8ed1" : "#1b2230";
    case N:
      return "#f06a8a";
    case W:
      return "#ffffff";
    case S:
      return coat.dark;
    case K:
      return "#ff2bd6";
    default:
      return "";
  }
}

interface Props {
  breed?: string;
  color?: string;
  mood?: Mood;
  size?: number;
  // Still freezes the animation (a picker thumbnail, a screenshot).
  still?: boolean;
  class?: string;
  title?: string;
}

// PixelCat draws the avatar and keeps it moving.
export default function PixelCat({
  breed = "tabby",
  color = "orange",
  mood = "idle",
  size = 32,
  still,
  class: cls,
  title,
}: Props) {
  const [frame, setFrame] = useState(0);
  const period =
    mood === "idle" ? 700 : mood === "sleeping" ? 1200 : mood === "working" ? 260 : 380;
  useEffect(() => {
    if (still || document.documentElement.dataset.motion === "off") {
      return;
    }
    const id = setInterval(() => setFrame((f) => f + 1), period);
    return () => clearInterval(id);
  }, [period, still]);
  const b = (BREEDS as readonly string[]).includes(breed) ? (breed as Breed) : "tabby";
  const coat = COATS[color] || COATS.orange;
  const g = grid(b, mood, frame);
  const rects: preact.JSX.Element[] = [];
  g.forEach((row, y) =>
    row.forEach((v, x) => {
      const fill = paint(v, coat, b, color);
      if (fill) {
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={fill} />);
      }
    }),
  );
  // The tail swishes on idle: the tip moves one pixel every other frame.
  const tailUp = mood === "idle" && frame % 4 >= 2;
  return (
    <span
      class={`pixelcat mood-${mood} ${cls || ""}`}
      style={`width:${size}px;height:${size}px`}
      title={title}
      data-frame={frame}
    >
      <svg
        viewBox="0 0 17 16"
        width={size}
        height={size}
        shape-rendering="crispEdges"
        aria-label={`${b} ${color} cat, ${mood}`}
        role="img"
      >
        <g transform={tailUp ? "translate(0,0)" : "translate(0,0)"}>{rects}</g>
        {tailUp && <rect x="16" y="10" width="1" height="1" fill={coat.dark} />}
      </svg>
      {mood === "thinking" && <span class="cat-bubble">{"·".repeat((frame % 3) + 1)}</span>}
      {mood === "sleeping" && <span class="cat-zzz">z</span>}
      {mood === "working" && <span class="cat-spark">✦</span>}
    </span>
  );
}

// Picker lets a person choose the breed and the coat, with every cat shown alive.
export function CatPicker({
  breed,
  color,
  onChange,
}: {
  breed: string;
  color: string;
  onChange: (a: { breed: string; color: string }) => void;
}) {
  return (
    <div>
      <div class="flex flex-wrap gap-2 mt-1">
        {BREEDS.map((b) => (
          <button
            key={b}
            type="button"
            class={`plain cat-choice ${b === breed ? "on" : ""}`}
            onClick={() => onChange({ breed: b, color })}
            aria-label={b}
            title={b}
          >
            <PixelCat breed={b} color={color} mood={b === breed ? "happy" : "idle"} size={44} />
            <span class="text-[10px] font-mono uppercase tracking-wider">{b}</span>
          </button>
        ))}
      </div>
      <div class="flex flex-wrap gap-1.5 mt-3">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            class={`plain cat-swatch ${c === color ? "on" : ""}`}
            style={`background:${COATS[c].body};border-color:${COATS[c].dark}`}
            onClick={() => onChange({ breed, color: c })}
            aria-label={COATS[c].label}
            title={COATS[c].label}
          />
        ))}
      </div>
    </div>
  );
}
