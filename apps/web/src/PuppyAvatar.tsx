// PuppyAvatar draws a puppy as a small 3D dog: it breathes, blinks, follows the pointer with its
// eyes and body, and eases between moods (idle, thinking, happy). Pointing at it cheers it up.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AvatarMotion } from "./bot-avatar/index.ts";
import { mountAvatar, type AvatarOptions, type MountedAvatar } from "./bot-avatar/dom/index.ts";
import { BREEDS, PUPPIES, COATS, COLORS, breedOf, coatOf, skinOf } from "./puppies";
import { t } from "./i18n";

type View = { yaw: number; pitch: number };

interface Props {
  breed?: string;
  color?: string;
  mood?: AvatarMotion;
  size?: number;
  // Look toward the pointer anywhere on the page (live avatars; on by default).
  follow?: boolean;
  // Turn happy while the pointer is over it (on by default).
  cheer?: boolean;
  // Extra rotation, e.g. dragged on a stage.
  view?: View;
  // Keep looking where it looks now (while the view is dragged).
  holdGaze?: boolean;
  // One static image: thumbnails and long lists.
  still?: boolean;
  // Accessible name; "" when the text beside it already names the kitty.
  label?: string;
  class?: string;
}

const motionOff = () => document.documentElement.dataset.motion === "off";

export default function PuppyAvatar({ breed, color, mood = "idle", size = 32, follow = true, cheer = true, view, holdGaze, still, label = "", class: cls }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const [pointed, setPointed] = useState(false);
  const b = breedOf(breed), c = coatOf(color);
  const options: Partial<AvatarOptions> = {
    definition: PUPPIES[b].definition,
    color: COATS[c].body,
    eyeColor: COATS[c].ink,
    skin: useMemo(() => skinOf(b, c), [b, c]),
    mood: cheer && pointed && !still ? "happy" : mood,
    followPointer: follow && !still,
    holdGaze: !!holdGaze,
    view: view ?? { yaw: 0, pitch: 0 },
    label,
    reducedMotion: motionOff() ? true : "system",
  };
  // `still` decides the kind of scene, so a change mounts it again.
  useEffect(() => {
    avatar.current = mountAvatar(host.current!, { ...options, still } as AvatarOptions);
    return () => {
      avatar.current?.destroy();
      avatar.current = null;
    };
  }, [still]);
  useEffect(() => avatar.current?.update(options));
  return (
    <span
      ref={host}
      class={`pup-avatar ${cls ?? ""}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      onPointerEnter={cheer && !still ? () => setPointed(true) : undefined}
      onPointerLeave={cheer && !still ? () => setPointed(false) : undefined}
    />
  );
}

const MOODS: { value: AvatarMotion; label: string }[] = [
  { value: "idle", label: "Idle" },
  { value: "thinking", label: "Thinking" },
  { value: "happy", label: "Happy" },
];
const PITCH_LIMIT = 0.9;
const clampPitch = (p: number) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
// Keep yaw in -π..π so a reset never spins the long way round.
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// PuppyStage shows one puppy large: it follows the pointer, turns when dragged (double-click or Home
// resets), and plays the mood chosen below it.
export function PuppyStage({ breed, color, size = 150 }: { breed: string; color: string; size?: number }) {
  const [mood, setMood] = useState<AvatarMotion>("idle");
  const [view, setView] = useState<View>({ yaw: 0, pitch: 0 });
  const drag = useRef<{ id: number; x: number; y: number; start: View } | null>(null);
  const [dragging, setDragging] = useState(false);
  const easing = useRef(0);
  useEffect(() => () => cancelAnimationFrame(easing.current), []);
  const reset = () => {
    cancelAnimationFrame(easing.current);
    const from = { yaw: wrap(view.yaw), pitch: view.pitch };
    if (motionOff() || matchMedia("(prefers-reduced-motion: reduce)").matches) return setView({ yaw: 0, pitch: 0 });
    const start = performance.now();
    const step = (now: number) => {
      const k = 1 - (1 - Math.min(1, (now - start) / 420)) ** 3;
      setView({ yaw: from.yaw * (1 - k), pitch: from.pitch * (1 - k) });
      if (k < 1) easing.current = requestAnimationFrame(step);
    };
    easing.current = requestAnimationFrame(step);
  };
  const keys: Record<string, (v: View, s: number) => View> = {
    ArrowLeft: (v, s) => ({ yaw: wrap(v.yaw - s), pitch: v.pitch }),
    ArrowRight: (v, s) => ({ yaw: wrap(v.yaw + s), pitch: v.pitch }),
    ArrowUp: (v, s) => ({ yaw: v.yaw, pitch: clampPitch(v.pitch + s) }),
    ArrowDown: (v, s) => ({ yaw: v.yaw, pitch: clampPitch(v.pitch - s) }),
  };
  return (
    <div class="pup-stage">
      <div
        class={`pup-stage-view ${dragging ? "dragging" : ""}`}
        tabIndex={0}
        role="group"
        aria-roledescription={t("3D preview")}
        aria-label={t("Drag or use the arrow keys to turn the puppy; Home resets the view.")}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          cancelAnimationFrame(easing.current);
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: view };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d?.id !== e.pointerId) return;
          setView({ yaw: d.start.yaw + (e.clientX - d.x) * 0.011, pitch: clampPitch(d.start.pitch - (e.clientY - d.y) * 0.009) });
        }}
        onPointerUp={(e) => {
          if (drag.current?.id !== e.pointerId) return;
          drag.current = null;
          setDragging(false);
          setView((v) => ({ yaw: wrap(v.yaw), pitch: v.pitch }));
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDblClick={reset}
        onKeyDown={(e) => {
          if (e.key === "Home" || e.key === "Escape") {
            e.preventDefault();
            return reset();
          }
          const move = keys[e.key];
          if (!move) return;
          e.preventDefault();
          cancelAnimationFrame(easing.current);
          setView(move(view, e.shiftKey ? 0.6 : 0.2));
        }}
      >
        <PuppyAvatar breed={breed} color={color} size={size} mood={mood} view={view} holdGaze={dragging} cheer={false} />
      </div>
      <div class="pup-moods" role="radiogroup" aria-label={t("Mood")}>
        {MOODS.map((m) => (
          <button key={m.value} type="button" role="radio" aria-checked={mood === m.value} class={mood === m.value ? "on" : ""} onClick={() => setMood(m.value)}>
            {t(m.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

// PuppyPicker chooses the silhouette and the coat: a live preview of the choice, and every puppy
// shown in the chosen coat.
export function PuppyPicker({ breed, color, onChange }: { breed: string; color: string; onChange: (pick: { breed: string; color: string }) => void }) {
  const b = breedOf(breed), c = coatOf(color);
  return (
    <div class="pup-picker">
      <PuppyStage breed={b} color={c} />
      <div class="pup-picker-choices">
        <div role="radiogroup" aria-label={t("Avatar")} class="pup-picker-row">
          {BREEDS.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={id === b} class={id === b ? "on" : ""} title={t(PUPPIES[id].definition.name)} onClick={() => onChange({ breed: id, color: c })}>
              <PuppyAvatar breed={id} color={c} size={48} still />
              <span>{t(PUPPIES[id].definition.name)}</span>
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label={t("Color")} class="pup-picker-row">
          {COLORS.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={id === c} aria-label={t(COATS[id].label)} title={t(COATS[id].label)} class={`pup-swatch ${id === c ? "on" : ""}`} style={{ background: `linear-gradient(135deg, ${COATS[id].body} 55%, ${COATS[id].accent} 55%)` }} onClick={() => onChange({ breed: b, color: id })} />
          ))}
        </div>
      </div>
    </div>
  );
}
