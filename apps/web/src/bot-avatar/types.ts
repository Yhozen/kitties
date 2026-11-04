/**
 * Avatar definition contract v1 (see docs/avatar-contract.md).
 *
 * A definition is geometry only: one monochrome silhouette path in a fixed
 * 0 0 100 100 viewBox plus a placement for the eye pair. Everything else
 * (color, implied volume, view, gaze, blinking, motion) is owned by the
 * runtime renderer.
 */

export interface AvatarEyes {
  /** Center of the eye pair, viewBox units. */
  x: number;
  y: number;
  /** Center-to-center distance between the two eyes, viewBox units. */
  spacing: number;
  /** 1 = each neutral eye is ~4 units wide and ~11 units tall. */
  scale: number;
}

export interface AvatarDefinition {
  version: 1;
  /** Lowercase slug, e.g. "controller". */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** One filled path, nonzero fill rule; holes wind opposite to their outline. */
  body: { path: string };
  eyes: AvatarEyes;
}

export type AvatarMotion = 'idle' | 'thinking' | 'happy';

/**
 * A mood easing in over what was shown before it: a plain mood, or a mood that
 * was itself still easing in (its progress frozen where it was). `t` 0..1.
 */
export interface AvatarMotionBlend {
  from: AvatarMotion | { motion: AvatarMotion; blend?: AvatarMotionBlend };
  t: number;
}

export interface RenderOptions {
  /** Body color as #rgb or #rrggbb. Invalid values fall back to the default. */
  color?: string;
  /** Eye color as #rgb or #rrggbb. Defaults to a plain near-black ink. */
  eyeColor?: string;
  /**
   * Rendered width/height in CSS pixels. Omit for a fluid SVG. In sceneFrame it lets small
   * live avatars skip cross-sections that would sit less than a pixel apart.
   */
  size?: number;
  /** Volume amount 0..14 (default 6 = natural depth; 0 = flat). Scales every part's inferred depth. */
  depth?: number;
  /** Extra view rotation in radians on top of the resting view (drag-to-turn). yaw turns left/right, pitch tips. */
  view?: { yaw: number; pitch: number };
  /** Animation clock in seconds. Same inputs always produce the same SVG. */
  time?: number;
  /**
   * Look target, each axis normalized -1..1 (x right, y down). Overrides idle eye
   * wander and turns the body toward it; `weight` (0..1, default 1) blends it in
   * over the idle pose so following can start and stop without a jump.
   */
  gaze?: { x: number; y: number; weight?: number };
  motion?: AvatarMotion;
  /**
   * Ease into `motion` from the mood shown before: the pose blends between the
   * two, and eyes that change shape close and reopen. Hosts leave it out once
   * `t` reaches 1 (and under reduced motion).
   */
  motionBlend?: AvatarMotionBlend;
  /** Freeze body motion and blinking at a calm pose; gaze still applies. */
  reducedMotion?: boolean;
  /** Puppies extension: per-part colors, soft shading and painted face decals. */
  skin?: AvatarSkin;
}

/**
 * Puppies extension (not upstream): how the body is painted. Colors are #rgb or #rrggbb.
 * With a skin, every cross-section is drawn (none are culled), so shading and decals show.
 */
export interface AvatarSkin {
  /** Fill per part, in subpath order; missing entries use the body color. */
  parts?: (string | undefined)[];
  /** Rim darkening, 0 (flat, the default) to 1: gives the volume a soft, clay-like gradient. */
  shade?: number;
  /**
   * Paint on the eye part, in viewBox units, projected onto its front along z: a muzzle, a
   * nose, a mouth, markings. Drawn into each front-facing cross-section, clipped to it.
   */
  decals?: SkinDecal[];
  /** Eye width multiplier (default 1): rounder, oval eyes instead of the contract's slim pills. */
  eyeWidth?: number;
  /** A small highlight in each open eye, e.g. "#ffffff". */
  eyeShine?: string;
  /** Per-part shift along depth in viewBox units, in subpath order: negative sets a part behind (ears behind a head). */
  offsets?: (number | undefined)[];
}

export interface SkinDecal {
  /** SVG path data, the same commands as a body path. */
  d: string;
  fill?: string;
  stroke?: string;
  /** Stroke width in viewBox units. */
  width?: number;
}

export type ValidationResult =
  | { ok: true; value: AvatarDefinition }
  | { ok: false; errors: string[] };
