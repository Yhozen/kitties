/**
 * Renderers for a validated silhouette + eye placement with implied volume
 * (see volume.ts). One flat body color, two plain dark eyes; no gradients,
 * gloss, rim light or shadows. Output is built only from numbers and the
 * renderer's own markup.
 *
 * - avatarFrame: one frame flattened to plain data (paths, matrices, eyes),
 *   for any vector renderer.
 * - renderAvatarSvg: a standalone still, serialized from avatarFrame. Cross-sections of the stack that
 *   faces the viewer are projected orthographically and painted back to front.
 * - renderAvatarScene + sceneFrame: a live CSS 3D scene. Every cross-section
 *   is its own small SVG placed once with a 3D transform; animating, turning
 *   and recoloring only change a few CSS transforms, and the browser's
 *   compositor does projection and occlusion.
 */
import { parseHex, shade as darken, toHex } from './color.ts';
import type { Rgb } from './color.ts';
import { computePose, hashString } from './motion.ts';
import type { Pose } from './motion.ts';
import type { Bounds, Point } from './path.ts';
import { EYE_H, EYE_W, GAZE_X, GAZE_Y, HAPPY_ARC, analyzeBody, eyeCenters, gazeRange, validateAvatar } from './validate.ts';
import type { GazeRange } from './validate.ts';
import { buildVolume } from './volume.ts';
import type { Volume, VolumeSlice } from './volume.ts';
import type { AvatarDefinition, AvatarSkin, RenderOptions, SkinDecal } from './types.ts';
import type { VolumePart } from './volume.ts';

export const DEFAULT_COLOR = '#ff6a1a';
export const DEFAULT_EYE_COLOR = '#151515';
/** `depth` option value that maps to the natural inferred volume. */
export const DEFAULT_DEPTH = 6;
const MAX_DEPTH = 14;
/**
 * Eyes sit this far above the surface so they never touch the body planes. iOS WebKit treats planes
 * closer than about a pixel as one and may draw the body over an eye (0.3 did: a band of the
 * barbell's bar through one eye), so the gap is a few pixels at the stage's size. Turned, an eye
 * drifts lift × sin(angle) from its spot: under half a unit at rest, about one at 45°.
 */
const EYE_LIFT = 1.5;

interface Prepared {
  def: AvatarDefinition;
  vol: Volume;
  range: GazeRange;
  seed: number;
  /** Prefix for SVG ids; equal geometry and depth always give equal ids, so repeats on a page are safe. */
  id: string;
  /** Stable SVG id per distinct cross-section path, assigned once. */
  ids: Map<string, string>;
  /** Slices kept at a rendered size, per stack, keyed by stack and rounded size. */
  detail: Map<string, boolean[]>;
}

const cache = new Map<string, Prepared>();

const f = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function depthOption(options: RenderOptions): number {
  const d = clamp(Number.isFinite(options.depth) ? (options.depth as number) : DEFAULT_DEPTH, 0, MAX_DEPTH);
  return Math.round(d * 2) / 2;
}

function prepare(definition: AvatarDefinition, depth: number): Prepared {
  const key = JSON.stringify([definition?.id, definition?.name, definition?.body?.path, definition?.eyes, depth]);
  const hit = cache.get(key);
  if (hit) return hit;
  const res = validateAvatar(definition);
  if (!res.ok) throw new Error(`Invalid avatar definition: ${res.errors.join('; ')}`);
  const def = res.value;
  const body = analyzeBody(def.body.path);
  const vol = buildVolume(def, depth / DEFAULT_DEPTH, body);
  const id = `oba-${hashString(`${def.id}|${def.body.path}|${depth}`).toString(36)}`;
  const ids = new Map<string, string>();
  for (const part of vol.parts) for (const s of [...part.zSlices, ...part.xSlices]) if (!ids.has(s.d)) ids.set(s.d, `${id}-${ids.size}`);
  const prepared: Prepared = {
    def,
    vol,
    range: gazeRange(body.polys, { ...def.eyes, scale: vol.eyeScale }),
    seed: hashString(def.id),
    id,
    ids,
    detail: new Map(),
  };
  if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
  cache.set(key, prepared);
  return prepared;
}

/** The validated definition and its cached volume, exactly as the renderers use them. Throws if invalid. */
export function preparedVolume(definition: AvatarDefinition, depth?: number): { def: AvatarDefinition; vol: Volume } {
  const p = prepare(definition, depthOption({ depth }));
  return { def: p.def, vol: p.vol };
}

function poseOf(p: Prepared, options: RenderOptions): Pose {
  const motion = options.motion === 'thinking' || options.motion === 'happy' ? options.motion : 'idle';
  return computePose({
    seed: p.seed,
    time: Number.isFinite(options.time) ? (options.time as number) : 0,
    motion,
    gaze: options.gaze,
    reducedMotion: options.reducedMotion === true,
    view: options.view,
    blend: options.motionBlend,
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------------
// View math

type M = Matrix;
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const about = (x: number, y: number, m: M): M => mul(translate(x, y), mul(m, translate(-x, -y)));
const mat = (m: M) => `matrix(${m.map((v, i) => (i < 4 ? (Math.round(v * 10000) / 10000).toString() : f(v))).join(' ')})`;

export interface ViewBasis {
  cY: number;
  sY: number;
  cP: number;
  sP: number;
  /** cos(yaw)·cos(pitch): > 0 when the front faces the viewer. */
  facing: number;
}

export function viewBasis(yaw: number, pitch: number): ViewBasis {
  const cY = Math.cos(yaw), cP = Math.cos(pitch);
  return { cY, sY: Math.sin(yaw), cP, sP: Math.sin(pitch), facing: cY * cP };
}

/** Minimum facing (toward-viewer component of the surface normal) for an eye to be drawn. */
const EYE_FACING = 0.22;

/** Toward-viewer component of a model-space direction under this view (1 = straight at the viewer). */
export function facingOf(v: ViewBasis, [x, y, z]: [number, number, number]): number {
  return v.sP * y + v.cP * (-v.sY * x + v.cY * z);
}

/** Whether eye `i` is drawn: every surface normal under it must face the viewer. */
function eyeVisible(vol: Volume, v: ViewBasis, i: number): boolean {
  return vol.eyeNormals[i].every((n) => facingOf(v, n) > EYE_FACING);
}

/** Which slice stack faces the viewer more: front-facing z-planes or side-facing x-planes. */
export function activeStack(v: ViewBasis): 'z' | 'x' {
  return Math.abs(v.cY) >= Math.abs(v.sY) ? 'z' : 'x';
}

/**
 * Orthographic projection of the plane at depth z, pivoting on `pivot` at z = 0.
 * Yaw turns about the vertical axis, then pitch tips about the horizontal axis.
 */
export function planeMatrix(v: ViewBasis, z: number, pivot: Point): M {
  const [cx, cy] = pivot;
  return [
    v.cY, v.sY * v.sP, 0, v.cP,
    cx - v.cY * cx + v.sY * z,
    cy - v.cP * cy - v.sY * v.sP * cx - v.cY * v.sP * z,
  ];
}

/** Projection of the side plane x = x0, whose local coordinates are (u = -z, y). */
export function sidePlaneMatrix(v: ViewBasis, x0: number, pivot: Point): M {
  const [cx, cy] = pivot;
  return [-v.sY, v.cY * v.sP, 0, v.cP, cx + v.cY * (x0 - cx), cy - v.cP * cy + v.sY * v.sP * (x0 - cx)];
}

/** Project a 3D point: screen x, screen y and depth toward the viewer. */
export function projectPoint(v: ViewBasis, [x, y, z]: [number, number, number], pivot: Point): [number, number, number] {
  const m = planeMatrix(v, z, pivot);
  const X = x - pivot[0], Y = y - pivot[1];
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], v.sP * Y + v.cP * (-v.sY * X + v.cY * z)];
}

function rootMatrix(pose: Pose, b: Bounds): M {
  const bx = (b.minX + b.maxX) / 2, by = b.maxY;
  const r = (pose.roll * Math.PI) / 180;
  const rot: M = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  return mul(translate(0, pose.lift), about(bx, by, mul(rot, [pose.sx, 0, 0, pose.sy, 0, 0])));
}

const pivotOf = (b: Bounds): Point => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/**
 * Every cross-section a view draws, with its projection: the stack facing the
 * viewer, minus z-slices hidden behind the core (they add nothing to the
 * silhouette or the paint). Their union is the silhouette on screen.
 */
// ---------------------------------------------------------------------------
// Skin (Puppies extension): per-part colors, rim shading and painted decals

interface Paint {
  fill: string;
  decals: SkinDecal[];
}

/** Whether a skin changes how slices are painted (so none may be culled). */
function skinned(skin: AvatarSkin | undefined): skin is AvatarSkin {
  return !!skin && (!!skin.parts?.length || (skin.shade ?? 0) > 0 || !!skin.decals?.length || !!skin.offsets?.some((o) => !!o));
}

/** A part's shift along depth (skin offsets), 0 by default. */
function offsetOf(skin: AvatarSkin | undefined, part: number): number {
  const o = skin?.offsets?.[part];
  return typeof o === 'number' && Number.isFinite(o) ? clamp(o, -50, 50) : 0;
}

/** How far a slice sits toward the rim of its part: 0 at the front (or side) apex, 1 at the outline. */
function rimOf(part: VolumePart, s: VolumeSlice): number {
  if (s.axis === 'z') return part.depth > 0 ? clamp(1 - Math.abs(s.at) / (part.depth / 2), 0, 1) : 1;
  const half = (part.bounds.maxX - part.bounds.minX) / 2;
  return half > 0 ? clamp(Math.abs(s.at - part.center[0]) / half, 0, 1) : 1;
}

const shadeHex = (hex: string | undefined, t: number, fallback: string): string => {
  const c = parseHex(hex) ?? (parseHex(fallback) as Rgb);
  return toHex(t > 0 ? darken(c, t) : c);
};

/** The fill of one slice and the decals painted into it, shaded alike. */
function paintOf(skin: AvatarSkin, vol: Volume, color: string, part: number, s: VolumeSlice): Paint {
  const t = clamp(skin.shade ?? 0, 0, 1) * rimOf(vol.parts[part], s) ** 1.6;
  const fill = shadeHex(skin.parts?.[part], t, color);
  const decals = s.axis === 'z' && part === vol.eyePart
    ? (skin.decals ?? []).map((d) => ({
        d: d.d,
        fill: d.fill ? shadeHex(d.fill, t, color) : undefined,
        stroke: d.stroke ? shadeHex(d.stroke, t, color) : undefined,
        width: d.width,
      }))
    : [];
  return { fill, decals };
}

function decalSvg(decals: SkinDecal[]): string {
  return decals
    .map((d) =>
      d.stroke
        ? `<path d="${esc(d.d)}" fill="${d.fill ?? 'none'}" stroke="${d.stroke}" stroke-width="${f(d.width ?? 1)}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${esc(d.d)}" fill="${d.fill ?? 'none'}"/>`,
    )
    .join('');
}

function drawnSlices(vol: Volume, v: ViewBasis, visit: (s: VolumeSlice, m: M, part: number, index: number) => void, skin?: AvatarSkin) {
  const stack = activeStack(v);
  const pivot = pivotOf(vol.bounds);
  const drawn = skin ? () => true : sliceCull(v);
  vol.parts.forEach((part, i) => {
    const o = offsetOf(skin, i);
    (stack === 'z' ? part.zSlices : part.xSlices).forEach((s, j) => {
      if (!drawn(s)) return;
      const m = stack === 'z' ? planeMatrix(v, s.at + o, pivot) : sidePlaneMatrix(v, s.at, pivot);
      // A side plane moved along depth: the screen shift of a z translation (see planeMatrix).
      if (stack === 'x' && o) {
        m[4] += v.sY * o;
        m[5] -= v.cY * v.sP * o;
      }
      visit(s, m, i, j);
    });
  });
}

/** Whether a slice of the active stack shows: z-slices hidden behind the core are skipped. */
function sliceCull(v: ViewBasis): (s: VolumeSlice) => boolean {
  // Screen shift per unit of depth, and the smallest on-screen size of an in-plane inset.
  const sweep = Math.hypot(v.sY, v.cY * v.sP);
  const inset = Math.min(Math.abs(v.cY), Math.abs(v.cP));
  return (s) => s.axis !== 'z' || s.inset <= 0 || Math.abs(s.at) * sweep > s.inset * inset;
}

// ---------------------------------------------------------------------------
// Eyes (shared by both renderers, in face-plane coordinates)

interface EyeState {
  /** Neutral center and size. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Gaze offset. */
  dx: number;
  dy: number;
  /** Drawn pill height after blink/squint, and its downward shift (lids close toward a point below center). */
  open: number;
  shift: number;
  happy: boolean;
  /** Stroke width of the happy arc: the contract eye's, however wide the skin draws the pill. */
  stroke: number;
}

/** Skin eye width multiplier (Puppies extension), 1 by default. */
const eyeWidthOf = (options: { skin?: AvatarSkin }) => clamp(Number.isFinite(options.skin?.eyeWidth) ? (options.skin?.eyeWidth as number) : 1, 0.5, 2.5);

function eyeStates(p: Prepared, pose: Pose, widen = 1): [EyeState, EyeState] {
  const s = p.vol.eyeScale;
  const w = EYE_W * s * widen, h = EYE_H * s;
  const stroke = EYE_W * s * HAPPY_ARC.stroke;
  const r = p.range;
  const dx = pose.gazeX * (pose.gazeX >= 0 ? r.right : r.left) * GAZE_X * s;
  const dy = pose.gazeY * (pose.gazeY >= 0 ? r.down : r.up) * GAZE_Y * s;
  const centers = eyeCenters(p.def.eyes);
  return ([0, 1] as const).map((i) => {
    const squint = i === 0 ? pose.squintL : pose.squintR;
    const open = Math.max(h * Math.max(0.09, (1 - pose.blink) * (1 - squint * 0.4)), w * 0.55);
    return { x: centers[i][0], y: centers[i][1], w, h, dx, dy, open, shift: (h - open) * 0.18, happy: pose.eyeShape === 'happy', stroke };
  }) as [EyeState, EyeState];
}

function happyArc(e: EyeState): string {
  const ex = e.x + e.dx, ey = e.y + e.dy;
  const hw = e.w * HAPPY_ARC.halfWidth, base = ey + e.h * HAPPY_ARC.base;
  return `M${f(ex - hw)} ${f(base)}Q${f(ex)} ${f(ey - e.h * HAPPY_ARC.peak)} ${f(ex + hw)} ${f(base)}`;
}

function eyeMark(e: EyeState): EyeMark {
  if (e.happy) return { shape: 'arc', d: happyArc(e), strokeWidth: e.stroke };
  const cx = e.x + e.dx, cy = e.y + e.dy + e.shift;
  return { shape: 'pill', x: cx - e.w / 2, y: cy - e.open / 2, width: e.w, height: e.open, radius: Math.min(e.w, e.open) / 2 };
}

function colors(options: RenderOptions): { color: string; ink: string } {
  return {
    color: toHex(parseHex(options.color) ?? (parseHex(DEFAULT_COLOR) as Rgb)),
    ink: toHex(parseHex(options.eyeColor) ?? (parseHex(DEFAULT_EYE_COLOR) as Rgb)),
  };
}

// ---------------------------------------------------------------------------
// Flat frames: the whole projected avatar as plain data

/** 2D affine matrix in SVG order (a b c d e f). */
export type Matrix = [number, number, number, number, number, number];

/** How one eye is drawn, in its face plane's coordinates (viewBox units). */
export type EyeMark =
  | { shape: 'pill'; x: number; y: number; width: number; height: number; radius: number }
  | { shape: 'arc'; d: string; strokeWidth: number };

export type FrameShape =
  | {
      kind: 'slice';
      /** Stable across frames for the same cross-section: use it as a key in retained renderers. */
      key: string;
      /** Id of an entry in AvatarFrame.paths. */
      path: string;
      matrix: Matrix;
      /** With a skin: this slice's own fill, and decals clipped to its path. */
      fill?: string;
      decals?: SkinDecal[];
    }
  | { kind: 'eye'; key: 'eye-0' | 'eye-1'; matrix: Matrix; mark: EyeMark; shine?: string };

/**
 * One frame of the avatar flattened onto the screen: every cross-section the
 * view draws with its projection, and the visible eyes, sorted back to front.
 * Painting them in order (body paths in `color`, eyes in `ink`) inside the
 * `root` transform and a 0 0 100 100 viewBox gives the avatar exactly as
 * renderAvatarSvg draws it. Plain numbers and path strings, so any vector
 * renderer (SVG, canvas, Skia, react-native-svg) can draw it.
 */
export interface AvatarFrame {
  name: string;
  color: string;
  ink: string;
  /** Distinct cross-section paths this frame uses; ids are stable for equal geometry and depth. */
  paths: { id: string; d: string; evenOdd: boolean }[];
  /** 2D motion (hop, roll, squash) about the base of the body, applied to every shape. */
  root: Matrix;
  /** Back to front. */
  shapes: FrameShape[];
}

/** Compute one flat frame of a definition. Throws if the definition is invalid. */
export function avatarFrame(definition: AvatarDefinition, options: RenderOptions = {}): AvatarFrame {
  const p = prepare(definition, depthOption(options));
  const { vol } = p;
  const b = vol.bounds;
  const { color, ink } = colors(options);
  const pose = poseOf(p, options);
  const pivot = pivotOf(b);
  const v = viewBasis(pose.yaw, pose.pitch);
  const stack = activeStack(v);
  const eyesMid: Point = [p.def.eyes.x, p.def.eyes.y];

  // Only the cross-sections this view draws are listed; ids are stable across frames.
  const paths = new Map<string, { id: string; d: string; evenOdd: boolean }>();
  const items: { depth: number; shape: FrameShape }[] = [];
  const skin = skinned(options.skin) ? options.skin : undefined;
  drawnSlices(vol, v, (s, m, i, j) => {
    let path = paths.get(s.d);
    if (!path) {
      path = { id: p.ids.get(s.d) as string, d: s.d, evenOdd: s.evenOdd };
      paths.set(s.d, path);
    }
    // Depth keys are taken under the eyes for the eye part, so only depth decides eye-vs-body order there.
    const [rx, ry] = i === vol.eyePart ? eyesMid : vol.parts[i].center;
    const o = offsetOf(skin, i);
    const depth = stack === 'z' ? projectPoint(v, [rx, ry, s.at + o], pivot)[2] : projectPoint(v, [s.at, ry, o], pivot)[2];
    const paint = skin ? paintOf(skin, vol, color, i, s) : undefined;
    items.push({
      depth,
      shape: {
        kind: 'slice',
        key: `${i}${stack}${j}`,
        path: path.id,
        matrix: m,
        ...(paint ? { fill: paint.fill, ...(paint.decals.length ? { decals: paint.decals } : {}) } : {}),
      },
    });
  }, skin);
  // Painted on the surface; each eye goes once the surface under it turns away.
  eyeStates(p, pose, eyeWidthOf(options)).forEach((e, idx) => {
    if (eyeVisible(vol, v, idx)) {
      const z = vol.eyeZ[idx] + EYE_LIFT + offsetOf(skin, vol.eyePart);
      items.push({
        depth: projectPoint(v, [eyesMid[0], eyesMid[1], z], pivot)[2] + 1e-6,
        shape: { kind: 'eye', key: idx === 0 ? 'eye-0' : 'eye-1', matrix: planeMatrix(v, z, pivot), mark: eyeMark(e), shine: skin?.eyeShine },
      });
    }
  });
  items.sort((a, c) => a.depth - c.depth);
  return { name: p.def.name, color, ink, paths: [...paths.values()], root: rootMatrix(pose, b), shapes: items.map((it) => it.shape) };
}

/** Eye highlight (skin eyeShine): center and size as fractions of the pill. */
const SHINE = { x: 0.66, y: 0.27, w: 0.32, h: 0.2 };

// ---------------------------------------------------------------------------
// Standalone SVG still

function eyeSvg(mark: EyeMark, ink: string, shine?: string): string {
  if (mark.shape === 'arc') {
    return `<path d="${mark.d}" fill="none" stroke="${ink}" stroke-width="${f(mark.strokeWidth)}" stroke-linecap="round"/>`;
  }
  const glint = shine && parseHex(shine)
    ? `<ellipse cx="${f(mark.x + mark.width * SHINE.x)}" cy="${f(mark.y + mark.height * SHINE.y)}" rx="${f(mark.width * SHINE.w / 2)}" ry="${f(mark.height * SHINE.h / 2)}" fill="${toHex(parseHex(shine) as Rgb)}"/>`
    : '';
  return `<rect x="${f(mark.x)}" y="${f(mark.y)}" width="${f(mark.width)}" height="${f(mark.height)}" rx="${f(mark.radius)}" fill="${ink}"/>${glint}`;
}

/** Render a definition to a standalone SVG string. Throws if the definition is invalid. */
export function renderAvatarSvg(definition: AvatarDefinition, options: RenderOptions = {}): string {
  const frame = avatarFrame(definition, options);
  const clipped = new Set(frame.shapes.flatMap((s) => (s.kind === 'slice' && s.decals ? [s.path] : [])));
  const defsMarkup = frame.paths
    .map((d) => {
      const rule = d.evenOdd ? ' fill-rule="evenodd"' : '';
      const clip = clipped.has(d.id) ? `<mask id="${d.id}-clip" maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140"><path d="${d.d}"${rule} fill="#fff"/></mask>` : '';
      return `<path id="${d.id}" d="${d.d}"${rule}/>${clip}`;
    })
    .join('');
  const sliceSvg = (s: Extract<FrameShape, { kind: 'slice' }>) => {
    const fill = s.fill ? ` fill="${s.fill}"` : '';
    if (!s.decals) return `<use href="#${s.path}" transform="${mat(s.matrix)}"${fill}/>`;
    // The fill and the paint are masked together so their shared edge is smoothed once.
    return `<g transform="${mat(s.matrix)}"><g mask="url(#${s.path}-clip)"><rect x="-20" y="-20" width="140" height="140"${fill}/>${decalSvg(s.decals)}</g></g>`;
  };
  const body = frame.shapes
    .map((s) => (s.kind === 'slice' ? sliceSvg(s) : `<g transform="${mat(s.matrix)}">${eyeSvg(s.mark, frame.ink, s.shine)}</g>`))
    .join('');
  const size = Number.isFinite(options.size) && (options.size as number) > 0 ? f(clamp(options.size as number, 8, 4096)) : null;
  const dims = size ? ` width="${size}" height="${size}"` : '';
  const label = esc(frame.name);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dims} role="img" aria-label="${label}" overflow="visible">` +
    `<title>${label}</title>` +
    `<defs>${defsMarkup}</defs>` +
    `<g transform="${mat(frame.root)}" fill="${frame.color}">` +
    body +
    `</g></svg>`
  );
}

// ---------------------------------------------------------------------------
// Live CSS 3D scene

/** Counter for unique mask ids in skinned live scenes. */
let sceneSeq = 0;

/** 1 viewBox unit = 1% of the scene's (square) container width. */
const u = (n: number) => `${f(n)}cqw`;
const FILL = 'position:absolute;left:0;top:0;width:100%;height:100%;';

function sliceMarkup(s: VolumeSlice, paint?: Paint, clipId?: string, offset = 0): string {
  const pad = 0.3;
  const x = s.box.x - pad, y = s.box.y - pad, w = s.box.w + 2 * pad, h = s.box.h + 2 * pad;
  const rule = s.evenOdd ? ' fill-rule="evenodd"' : '';
  const place = s.axis === 'z'
    ? `left:${u(x)};top:${u(y)};transform:translateZ(${u(s.at + offset)})`
    : // The side plane's u = 0 line sits at x = s.at; turning it 90° about that line maps u to -z.
      `left:${u(s.at + x)};top:${u(y)};transform-origin:${u(-x)} 50%;transform:${offset ? `translateZ(${u(offset)}) ` : ''}rotateY(90deg)`;
  return (
    `<svg viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" style="position:absolute;width:${u(w)};height:${u(h)};overflow:visible;${place}" aria-hidden="true">` +
    // With decals, the fill and the paint are masked together by the cross-section, so their shared
    // edge is smoothed once. (clip-path leaves a hairline of the fill along every slice edge in Chrome.)
    (paint?.decals.length && clipId
      ? `<mask id="${clipId}" maskUnits="userSpaceOnUse" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"><path d="${s.d}"${rule} fill="#fff"/></mask>` +
        `<g mask="url(#${clipId})"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${paint.fill}"/>${decalSvg(paint.decals)}</g>`
      : `<path d="${s.d}"${rule} fill="${paint ? paint.fill : 'currentColor'}"/>`) +
    `</svg>`
  );
}

/**
 * Static markup of the live scene for a definition and depth. Mount it once,
 * then apply `sceneFrame` every frame. Body color comes from CSS `color` on
 * an ancestor, eye ink from `--avatar-ink`.
 */
export function renderAvatarScene(definition: AvatarDefinition, options: Pick<RenderOptions, 'depth' | 'skin' | 'color'> = {}): string {
  const p = prepare(definition, depthOption(options));
  const { vol } = p;
  const skin = skinned(options.skin) ? options.skin : undefined;
  const { color } = colors(options);
  // Mask ids are unique per mounted scene: a url(#id) resolves to the first match in the document,
  // which may sit in another avatar's slice that is hidden (display:none), and then masks nothing.
  const skinId = skin ? `${hashString(JSON.stringify([skin, color])).toString(36)}-${(sceneSeq++).toString(36)}` : '';
  const b = vol.bounds;
  const [cx, cy] = pivotOf(b);
  const ink = `var(--avatar-ink,${DEFAULT_EYE_COLOR})`;
  const stack = (axis: 'z' | 'x') =>
    `<div data-stack="${axis}" style="${FILL}transform-style:preserve-3d">` +
    vol.parts
      .map((part, i) =>
        (axis === 'z' ? part.zSlices : part.xSlices)
          .map((s, j) => sliceMarkup(s, skin ? paintOf(skin, vol, color, i, s) : undefined, `${p.id}-${skinId}-${i}${axis}${j}`, offsetOf(skin, i)))
          .join(''),
      )
      .join('') +
    `</div>`;
  const shine = skin?.eyeShine && parseHex(skin.eyeShine)
    ? `<b style="position:absolute;left:${(SHINE.x - SHINE.w / 2) * 100}%;top:${(SHINE.y - SHINE.h / 2) * 100}%;width:${SHINE.w * 100}%;height:${SHINE.h * 100}%;border-radius:50%;background:${toHex(parseHex(skin.eyeShine) as Rgb)}"></b>`
    : '';
  const eyes = eyeStates(p, poseOf(p, { reducedMotion: true }), eyeWidthOf(options)).map((e, i) => {
    const box = `left:${u(e.x - e.w / 2)};top:${u(e.y - e.h / 2)};width:${u(e.w)};height:${u(e.h)}`;
    return (
      `<div data-eye="${i}" style="position:absolute;${box};backface-visibility:hidden;transform:translateZ(${u(vol.eyeZ[i] + EYE_LIFT + offsetOf(skin, vol.eyePart))})">` +
      `<i style="position:absolute;inset:0;border-radius:999px;background:${ink}">${shine}</i>` +
      `<svg viewBox="${f(e.x - e.w / 2)} ${f(e.y - e.h / 2)} ${f(e.w)} ${f(e.h)}" style="${FILL}overflow:visible;display:none" aria-hidden="true">` +
      `<path d="${happyArc(e)}" fill="none" stroke="${ink}" stroke-width="${f(e.stroke)}" stroke-linecap="round"/></svg>` +
      `</div>`
    );
  });
  return (
    `<div data-avatar-scene="${p.id}" style="position:relative;width:100%;height:100%;container-type:size">` +
    // will-change pins the slices' raster scale: without it every hop and squash re-rasterizes each slice.
    `<div data-motion style="${FILL}will-change:transform;transform-origin:${u((b.minX + b.maxX) / 2)} ${u(b.maxY)}">` +
    `<div data-view style="${FILL}transform-style:preserve-3d;transform-origin:${u(cx)} ${u(cy)}">` +
    stack('z') + stack('x') + eyes.join('') +
    `</div></div></div>`
  );
}

export interface SceneFrame {
  /** Identifies the static markup this frame belongs to. */
  scene: string;
  /** 2D motion (hop, roll, squash) about the base of the body. */
  motion: string;
  /** 3D view rotation about the body center. */
  view: string;
  stack: 'z' | 'x';
  /** Per slice of the active stack, in markup order: whether it shows. Hidden ones need no layer. */
  slices: boolean[];
  eyes: { visible: boolean; happy: boolean; transform: string; pill: string }[];
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Closest on-screen spacing, CSS px, between cross-sections a small live avatar keeps. */
const SLICE_GAP_PX = 0.75;

/**
 * Per slice of a stack, in markup order: whether it is kept at this rendered size. Within each part,
 * slices closer than SLICE_GAP_PX to the last kept one are dropped; the outermost always stay, and
 * so does the core, which sliceCull relies on to cover the inset slices it hides.
 */
function sliceDetail(p: Prepared, stack: 'z' | 'x', size: number | undefined): boolean[] {
  const px = Number.isFinite(size) && (size as number) > 0 ? Math.round(size as number) : 0;
  const key = `${stack}${px}`;
  let keep = p.detail.get(key);
  if (keep) return keep;
  const gap = px ? (SLICE_GAP_PX * 100) / px : 0;
  keep = p.vol.parts.flatMap((part) => {
    const slices = stack === 'z' ? part.zSlices : part.xSlices;
    let last = -Infinity;
    return slices.map((s, j) => {
      const core = s.axis === 'z' && s.at === 0 && s.inset === 0;
      const kept = core || j === 0 || j === slices.length - 1 || s.at - last >= gap;
      if (kept) last = s.at;
      return kept;
    });
  });
  if (p.detail.size >= 32) p.detail.clear();
  p.detail.set(key, keep);
  return keep;
}

/** Per-frame CSS for a mounted scene. Pure and cheap: no geometry is rebuilt. */
export function sceneFrame(definition: AvatarDefinition, options: RenderOptions = {}): SceneFrame {
  const p = prepare(definition, depthOption(options));
  const pose = poseOf(p, options);
  const v = viewBasis(pose.yaw, pose.pitch);
  const states = eyeStates(p, pose, eyeWidthOf(options));
  const stack = activeStack(v);
  const drawn = skinned(options.skin) ? () => true : sliceCull(v);
  const kept = sliceDetail(p, stack, options.size);
  let k = 0;
  return {
    scene: p.id,
    motion: `translate(0,${u(pose.lift)}) rotate(${f(pose.roll)}deg) scale(${r4(pose.sx)},${r4(pose.sy)})`,
    view: `rotateX(${r4(pose.pitch)}rad) rotateY(${r4(pose.yaw)}rad)`,
    stack,
    slices: p.vol.parts.flatMap((part) => (stack === 'z' ? part.zSlices : part.xSlices).map((s) => kept[k++] && drawn(s))),
    eyes: states.map((e, i) => ({
      visible: eyeVisible(p.vol, v, i),
      happy: e.happy,
      transform: `translateZ(${u(p.vol.eyeZ[i] + EYE_LIFT + offsetOf(options.skin, p.vol.eyePart))}) translate(${u(e.dx)},${u(e.dy)})`,
      pill: `translateY(${u(e.shift)}) scaleY(${r4(e.open / e.h)})`,
    })),
  };
}
