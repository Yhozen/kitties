import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type Kitty, rectsDesktop, shotData, streamDesktop } from "./api";
import { DesktopInputQueue } from "./desktop-input";
import { plainError } from "./friendly";
import { t } from "./i18n";
import { IconExpand, IconReduce, IconX } from "./icons";

// LIVE DESKTOP: the kitty's display as it is now, followed while it is open: first as what
// changed on it (rectangles drawn on a canvas, like VNC), else as motion JPEG from the gateway
// (a whole picture whenever it changes), else as screenshots one after another. The person can
// take it over: their clicks, drags, the wheel and the keyboard go to the display, like on a
// remote screen, and the kitty's own actions wait until they give it back. Nothing is opened
// on the container: every frame and every input goes through the gateway's API.

// How often a frame is asked for: faster while the person has the controls.
const WATCH_EVERY = 1000;
const CONTROL_EVERY = 350;

// keyName is the X name of a key the browser names, or "" for one that is typed as text.
const NAMED: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

// xKeys turns a key press into what xdotool presses, or "" when it is plain text to type.
export function xKeys(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string {
  if (["Control", "Alt", "Shift", "Meta", "CapsLock", "Dead", "Unidentified"].includes(e.key)) {
    return "";
  }
  const named = NAMED[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : "");
  const chord = e.ctrlKey || e.altKey || e.metaKey;
  if (!named && !chord) {
    return "";
  }
  const mods = [
    e.ctrlKey && "ctrl",
    e.altKey && "alt",
    e.metaKey && "super",
    e.shiftKey && named && "shift",
  ].filter(Boolean);
  const key = named || (e.key === " " ? "space" : e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return [...mods, key].join("+");
}

// wasEnlarged and rememberEnlarged keep, in this browser, which kitties' desktops the person
// likes enlarged. A browser that keeps nothing just opens the card.
const ENLARGED = "kitties.desktop.enlarged";
function wasEnlarged(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(ENLARGED) || "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}
function rememberEnlarged(id: string, on: boolean): void {
  try {
    const rest = (JSON.parse(localStorage.getItem(ENLARGED) || "[]") as string[]).filter(
      (k) => k !== id,
    );
    localStorage.setItem(ENLARGED, JSON.stringify(on ? [...rest, id] : rest));
  } catch {
    /* private window */
  }
}

// loadFrame fetches one frame and resolves once it can be shown without a blank.
async function loadFrame(path: string, signal: AbortSignal): Promise<string> {
  const src = await shotData(path, "image/png", signal);
  await new Promise<void>((done, fail) => {
    const img = new Image();
    img.onload = () => done();
    img.onerror = () => {
      if (src.startsWith("blob:")) URL.revokeObjectURL(src);
      fail(new Error(t("The desktop did not answer")));
    };
    img.src = src;
  });
  return src;
}

const QUICK: [string, string][] = [
  ["Enter", "Return"],
  ["Tab", "Tab"],
  ["Esc", "Escape"],
  ["⌫", "BackSpace"],
  ["Ctrl+C", "ctrl+c"],
  ["Ctrl+A", "ctrl+a"],
  ["Alt+Tab", "alt+Tab"],
  ["Alt+F4", "alt+F4"],
];

// Gesture is a press or a drag in progress on the display, in the display's own pixels.
interface Gesture {
  from: { x: number; y: number };
  to: { x: number; y: number };
  drag: boolean;
}

// Ring is a mark that shows where an input went and fades.
interface Ring {
  id: number;
  x: number;
  y: number;
  kind: "click" | "double" | "right" | "drag" | "up" | "down";
}

// RING_ARROW marks a scroll ring with its direction.
const RING_ARROW: Record<string, string> = { up: "↑", down: "↓" };

// INPUT is the look of a text field here.
const INPUT = "w-full px-3 py-1.5 text-sm";

export default function LiveDesktop({
  kitty,
  onClose,
  autoControl,
  inline,
}: {
  kitty: Kitty;
  onClose: () => void;
  // autoControl takes the controls at once (the kitty asked for help).
  autoControl?: boolean;
  // inline shows the desktop where it is placed, as a card, and can be enlarged into a window
  // and reduced back; without it the desktop is a window that onClose closes.
  inline?: boolean;
}) {
  const [frame, setFrame] = useState("");
  const [waitingForStart, setWaitingForStart] = useState(kitty.status === "starting");
  useEffect(() => {
    if (waitingForStart && kitty.status === "running") setWaitingForStart(false);
  }, [waitingForStart, kitty.status]);
  const [control, setControl] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // mode is how the pictures come: rectangles of what changed, whole pictures of a stream, or
  // screenshots when each one before fails.
  const [mode, setMode] = useState<"rects" | "stream" | "poll">("rects");
  const [loaded, setLoaded] = useState(false);
  const [displayError, setDisplayError] = useState("");
  const firstFrameWait = 30_000;
  const [clip, setClip] = useState("");
  const [clipNote, setClipNote] = useState("");
  // Whether the person keeps this kitty's desktop enlarged: remembered, per kitty.
  const [expanded, setExpandedNow] = useState(() => !!inline && wasEnlarged(kitty.id));
  const setExpanded = (on: boolean) => {
    setExpandedNow(on);
    rememberEnlarged(kitty.id, on);
  };
  // What the person is doing and what is on its way, so every input can be seen to land: the
  // size of the display and of the room for it, the press or drag in progress, the rings where
  // a click went, the inputs still being sent, the text typed and not yet sent, and whether the
  // display has not yet shown what they did.
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [rings, setRings] = useState<Ring[]>([]);
  const [sending, setSending] = useState(0);
  const [typing, setTyping] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const waitTimer = useRef<number | undefined>(undefined);
  const ringId = useRef(0);
  const img = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const controlRef = useRef(false);
  controlRef.current = control;
  // The desktop is a card in the page or a window over it. Going from one to the other keeps the
  // controls and the state, and draws the picture anew (the display is sent whole again).
  const windowed = !inline || expanded;
  const view = windowed ? "window" : "card";
  const down = useRef<{ x: number; y: number; button: number } | null>(null);
  const pendingClick = useRef<number | undefined>(undefined);
  const typed = useRef("");
  const typeTimer = useRef<number | undefined>(undefined);
  const wheelAt = useRef(0);
  // queue sends the inputs one after another, in the order they were made: typed text and keys
  // sent side by side would reach the display mixed up.
  const lifetime = useRef(0);
  const inputs = useMemo(
    () =>
      new DesktopInputQueue(
        (id, action, args) => api.inputKitty(kitty.id, id, action, args),
        setSending,
        () => {
          setWaiting(true);
          clearTimeout(waitTimer.current);
          waitTimer.current = window.setTimeout(() => setWaiting(false), 2500);
        },
        (error, id) => {
          lifetime.current++;
          setBusy(false);
          clearUnsent();
          setErr(plainError(error instanceof Error ? error.message : String(error)));
          void api.controlKitty(kitty.id, false, id).catch(() => undefined);
        },
      ),
    [kitty.id],
  );

  const clearUnsent = () => {
    clearTimeout(typeTimer.current);
    clearTimeout(pendingClick.current);
    clearTimeout(waitTimer.current);
    typed.current = "";
    pendingClick.current = undefined;
    down.current = null;
    setGesture(null);
    setTyping(0);
    setWaiting(false);
    controlRef.current = false;
    setControl(false);
  };
  const releaseControl = () => {
    lifetime.current++;
    setBusy(false);
    const id = inputs.close();
    clearUnsent();
    if (id) void api.controlKitty(kitty.id, false, id).catch(() => undefined);
  };

  // seen is the display showing something new: what the person just did has had its effect.
  const seen = () => setWaiting(false);

  // The room the picture has: it is drawn as large as fits, with the display's own proportions.
  useEffect(() => {
    const el = surface.current;
    if (!el) {
      return;
    }
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [view]);

  // The rectangles: the whole display first, then only the parts that changed, drawn over it. One
  // that fails, or shows nothing in a few seconds, gives way to the stream of whole pictures.
  useEffect(() => {
    if (waitingForStart || mode !== "rects") {
      return;
    }
    let got = false;
    let alive = true;
    setLoaded(false);
    const fallback = (why: string) => {
      if (!alive) return;
      setDisplayError(plainError(why));
      releaseControl();
      setMode("stream");
    };
    // Updates are drawn in the order they came, each once all its pictures are decoded.
    let drawing: Promise<unknown> = Promise.resolve();
    const stop = rectsDesktop(
      kitty.id,
      {
        size: (w, h) => {
          if (canvas.current) {
            canvas.current.width = w;
            canvas.current.height = h;
          }
          setDims({ w, h });
        },
        rects: (list) => {
          drawing = drawing
            .then(async () => {
              const pictures = await Promise.all(list.map((r) => createImageBitmap(r.blob)));
              if (!alive) {
                pictures.forEach((picture) => picture.close());
                return;
              }
              const ctx = canvas.current?.getContext("2d");
              list.forEach((r, i) => {
                ctx?.drawImage(pictures[i], r.x, r.y);
                pictures[i].close();
              });
              seen();
              if (ctx && !got) {
                got = true;
                setLoaded(true);
                setDisplayError("");
              }
            })
            .catch((error) => fallback(String(error)));
        },
      },
      fallback,
    );
    if (!stop) {
      setMode("stream");
      return;
    }
    const id = setTimeout(() => !got && fallback(t("The desktop did not answer")), firstFrameWait);
    return () => {
      alive = false;
      clearTimeout(id);
      stop();
    };
  }, [kitty.id, mode, view, firstFrameWait, waitingForStart]);

  // The stream; one that fails, or shows nothing in a few seconds, gives way to screenshots.
  useEffect(() => {
    if (waitingForStart || mode !== "stream") {
      return;
    }
    let got = false;
    let alive = true;
    setLoaded(false);
    const fallback = (why: string) => {
      if (!alive) return;
      setDisplayError(plainError(why));
      releaseControl();
      setMode("poll");
    };
    const stop = streamDesktop(
      kitty.id,
      (src) => {
        if (!alive) return;
        got = true;
        setFrame(src);
        seen();
      },
      fallback,
    );
    const id = setTimeout(() => !got && fallback(t("The desktop did not answer")), firstFrameWait);
    return () => {
      alive = false;
      clearTimeout(id);
      stop();
    };
  }, [kitty.id, mode, firstFrameWait, waitingForStart]);

  // Screenshots: one after another, never two at once.
  useEffect(() => {
    if (waitingForStart || mode !== "poll") {
      return;
    }
    let alive = true;
    let n = 0;
    let last = "";
    let request: AbortController | undefined;
    setLoaded(false);
    (async () => {
      while (alive) {
        request = new AbortController();
        const timeout = setTimeout(() => request?.abort(), firstFrameWait);
        try {
          const src = await loadFrame(
            `/v1/kitties/${kitty.id}/screenshot?live=${n++}`,
            request.signal,
          );
          if (alive) {
            setFrame(src);
            setLoaded(true);
            setDisplayError("");
            seen();
          } else if (src.startsWith("blob:")) {
            URL.revokeObjectURL(src);
          }
          if (last.startsWith("blob:")) URL.revokeObjectURL(last);
          last = src;
        } catch (e) {
          if (alive) {
            releaseControl();
            setLoaded(false);
            setDisplayError(
              request.signal.aborted
                ? t("The desktop did not answer")
                : plainError(e instanceof Error ? e.message : String(e)),
            );
          }
        } finally {
          clearTimeout(timeout);
        }
        await new Promise((r) => setTimeout(r, controlRef.current ? CONTROL_EVERY : WATCH_EVERY));
      }
    })();
    return () => {
      alive = false;
      request?.abort();
      if (last.startsWith("blob:")) URL.revokeObjectURL(last);
    };
  }, [kitty.id, mode, firstFrameWait, waitingForStart]);

  // Asked for help: the controls are the person's as soon as the window opens.
  useEffect(() => {
    if (autoControl && !waitingForStart) {
      void take(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoControl, waitingForStart]);

  // Closing gives the display back, so the kitty never waits on a closed window.
  useEffect(
    () => () => {
      clearTimeout(waitTimer.current);
      clearTimeout(typeTimer.current);
      clearTimeout(pendingClick.current);
      lifetime.current++;
      const id = inputs.dispose();
      if (id) api.controlKitty(kitty.id, false, id).catch(() => undefined);
    },
    [kitty.id, inputs],
  );

  // What leaving the window does: a card goes back from the window, a window closes.
  const leave = inline ? () => setExpanded(false) : onClose;

  // Escape leaves the window, unless the person has the controls: then it is a key of the display.
  // It is taken first (and marked as used) so a drawer under the window stays open.
  useLayoutEffect(() => {
    if (!windowed) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !controlRef.current) {
        e.preventDefault();
        leave();
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [windowed, inline, onClose]);

  const send = (action: string, args: Record<string, unknown>) => {
    if (!inputs.enqueue(action, args)) {
      setErr(t("Too many inputs are waiting. Wait for them to finish."));
      return false;
    }
    return true;
  };

  // ring shows where an input went, for a moment.
  const ring = (at: { x: number; y: number }, kind: Ring["kind"]) => {
    const id = ++ringId.current;
    setRings((list) => [...list, { id, ...at, kind }]);
    setTimeout(() => setRings((list) => list.filter((r) => r.id !== id)), 800);
  };

  const take = async (on: boolean) => {
    const at = ++lifetime.current;
    setBusy(true);
    setErr("");
    let id = inputs.control;
    if (!on) {
      id = inputs.close();
      clearUnsent();
    }
    try {
      const grant = await api.controlKitty(kitty.id, on, id);
      if (at !== lifetime.current) {
        if (grant.control_id)
          void api.controlKitty(kitty.id, false, grant.control_id).catch(() => undefined);
        return;
      }
      if (on && (!grant.held || !grant.control_id))
        throw new Error(t("The desktop did not answer"));
      if (on) inputs.open(grant.control_id!);
      controlRef.current = grant.held;
      setControl(grant.held);
      if (on) setTimeout(() => surface.current?.focus(), 0);
    } catch (error) {
      if (at === lifetime.current)
        setErr(plainError(error instanceof Error ? error.message : String(error)));
    } finally {
      if (at === lifetime.current) setBusy(false);
    }
  };

  // The clipboard both ways: the person's text to the kitty's, and the kitty's to the person.
  const sendClip = async () => {
    try {
      await api.setClipboard(kitty.id, clip);
      setClipNote(t("On {name}'s clipboard: paste it there with Ctrl+V.", { name: kitty.name }));
    } catch (e) {
      setErr(plainError((e as Error).message));
    }
  };
  const takeClip = async () => {
    try {
      const text = await api.clipboard(kitty.id);
      setClip(text);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        /* no clipboard access here: the text is in the field to copy by hand */
      }
      setClipNote(
        !text
          ? t("{name}'s clipboard is empty.", { name: kitty.name })
          : copied
            ? t("Copied from {name}'s clipboard.", { name: kitty.name })
            : t("Here is {name}'s clipboard: copy it from the field.", { name: kitty.name }),
      );
    } catch (e) {
      setErr(plainError((e as Error).message));
    }
  };

  // point is where an event falls on the display, in its own pixels.
  const point = (e: MouseEvent) => {
    const el = canvas.current ?? img.current!;
    const r = el.getBoundingClientRect();
    const w = (el instanceof HTMLCanvasElement ? el.width : el.naturalWidth) || 1280;
    const h = (el instanceof HTMLCanvasElement ? el.height : el.naturalHeight) || 800;
    return {
      x: Math.max(0, Math.min(w - 1, Math.round(((e.clientX - r.left) * w) / r.width))),
      y: Math.max(0, Math.min(h - 1, Math.round(((e.clientY - r.top) * h) / r.height))),
    };
  };

  const flushTyped = () => {
    clearTimeout(typeTimer.current);
    if (typed.current) {
      if (!send("type", { text: typed.current })) return false;
      typed.current = "";
    }
    setTyping(0);
    return true;
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!control) {
      return;
    }
    e.preventDefault();
    surface.current?.focus();
    const from = point(e);
    down.current = { ...from, button: e.button };
    setGesture({ from, to: from, drag: false });
  };

  const onMouseMove = (e: MouseEvent) => {
    const from = down.current;
    if (!control || !from) {
      return;
    }
    const to = point(e);
    setGesture({ from, to, drag: Math.abs(to.x - from.x) > 4 || Math.abs(to.y - from.y) > 4 });
  };

  // Leaving the picture with the button down drops the gesture: nothing is sent.
  const onMouseLeave = () => {
    if (down.current) {
      down.current = null;
      setGesture(null);
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    const from = down.current;
    down.current = null;
    setGesture(null);
    if (!control || !from) {
      return;
    }
    e.preventDefault();
    if (!flushTyped()) return;
    const to = point(e);
    if (Math.abs(to.x - from.x) > 4 || Math.abs(to.y - from.y) > 4) {
      ring(to, "drag");
      send("drag", { x: from.x, y: from.y, to_x: to.x, to_y: to.y });
      return;
    }
    const button = ["left", "middle", "right"][from.button] || "left";
    if (button !== "left") {
      ring(to, "right");
      send("click", { ...to, button });
      return;
    }
    // A second click soon after is a double click: the first waits a moment to see.
    if (pendingClick.current !== undefined) {
      clearTimeout(pendingClick.current);
      pendingClick.current = undefined;
      ring(to, "double");
      send("double_click", to);
      return;
    }
    ring(to, "click");
    pendingClick.current = window.setTimeout(() => {
      pendingClick.current = undefined;
      send("click", to);
    }, 250);
  };

  const onWheel = (e: WheelEvent) => {
    if (!control) {
      return;
    }
    e.preventDefault();
    const now = Date.now();
    if (now - wheelAt.current < 120) {
      return;
    }
    wheelAt.current = now;
    ring(point(e), e.deltaY < 0 ? "up" : "down");
    if (!flushTyped() || !send("move", point(e))) return;
    send("scroll", { direction: e.deltaY < 0 ? "up" : "down", amount: 2 });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!control) {
      return;
    }
    // Ctrl+V (Cmd+V) pastes the person's own clipboard: the paste event types it.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v") {
      return;
    }
    const keys = xKeys(e);
    if (keys) {
      e.preventDefault();
      if (!flushTyped()) return;
      send("key", { keys });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      if (new TextEncoder().encode(typed.current + e.key).length > 2000) {
        setErr(t("Too many inputs are waiting. Wait for them to finish."));
        return;
      }
      typed.current += e.key;
      setTyping(typed.current.length);
      clearTimeout(typeTimer.current);
      typeTimer.current = window.setTimeout(flushTyped, 150);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text") || "";
    if (control && text) {
      e.preventDefault();
      if (!flushTyped()) return;
      send("type", { text: text.slice(0, 2000) });
    }
  };

  // The display is drawn as large as the room allows, with its own proportions: the marks over it
  // are placed in the display's pixels, so they stay where the person pointed.
  const scale = dims.w && room.w && room.h ? Math.min(room.w / dims.w, room.h / dims.h) : 0;
  const fit = scale
    ? { width: `${Math.floor(dims.w * scale)}px`, height: `${Math.floor(dims.h * scale)}px` }
    : {};
  const pct = (at: { x: number; y: number }) => ({
    left: `${dims.w ? (at.x / dims.w) * 100 : 0}%`,
    top: `${dims.h ? (at.y / dims.h) * 100 : 0}%`,
  });

  // What is going on, in one line: the person's own input first, then what is on its way.
  let activity: { tone: "ready" | "busy" | "drag"; text: string };
  if (gesture?.drag) {
    activity = { tone: "drag", text: t("Dragging: let go where it should end") };
  } else if (gesture) {
    activity = { tone: "busy", text: t("Button down: let go to click, or move to drag") };
  } else if (typing) {
    activity = { tone: "busy", text: t("Typing {n} characters…", { n: typing }) };
  } else if (sending) {
    activity = { tone: "busy", text: t("Sending to {name}'s desktop…", { name: kitty.name }) };
  } else if (waiting) {
    activity = { tone: "busy", text: t("Sent: waiting for the screen to change…") };
  } else {
    activity = { tone: "ready", text: t("Ready: click, drag, scroll or type on the picture") };
  }

  const liveState = waitingForStart
    ? kitty.error || t("Starting the computer…")
    : displayError
      ? t("The desktop did not answer")
      : !loaded
        ? t("Connecting to the desktop…")
        : control
          ? t("You have the controls: {name} waits", { name: kitty.name })
          : t("Watching live");
  const name = t("{name}'s desktop", { name: kitty.name });
  const content = (
    <>
      {windowed ? (
        <div class="flex items-center gap-2 flex-wrap shrink-0">
          <h2 class="font-mono text-base tracking-wide flex-1 min-w-0 truncate">{name}</h2>
          <span
            class={`state-pill max-w-full ${displayError || !loaded || control ? "is-working" : "is-ok"}`}
            data-testid="live-state"
          >
            {liveState}
          </span>
          {control ? (
            <button
              class="btn-accent px-3 py-1.5 text-sm flex items-center gap-2"
              onClick={() => take(false)}
              disabled={busy}
              data-testid="give-back"
            >
              {busy && <span class="spinner" />}
              {t("Give it back to {name}", { name: kitty.name })}
            </button>
          ) : (
            <button
              class="btn-accent px-3 py-1.5 text-sm flex items-center gap-2"
              onClick={() => take(true)}
              disabled={busy || !loaded}
              data-testid="take-control"
            >
              {busy && <span class="spinner" />}
              {t("Take control")}
            </button>
          )}
          <button
            class="plain p-1 text-[var(--t3)] hover:text-[var(--t1)]"
            onClick={leave}
            aria-label={inline ? t("Reduce") : t("Close")}
          >
            {inline ? <IconReduce /> : <IconX />}
          </button>
        </div>
      ) : (
        <div class="flex items-center gap-2 flex-wrap">
          <span
            class={`state-pill max-w-full ${displayError || !loaded || control ? "is-working" : "is-ok"}`}
            data-testid="live-state"
          >
            {liveState}
          </span>
          <span class="flex-1" />
          {control ? (
            <button
              class="btn-accent px-3 py-1.5 text-sm flex items-center gap-2"
              onClick={() => take(false)}
              disabled={busy}
              data-testid="give-back"
            >
              {busy && <span class="spinner" />}
              {t("Give it back to {name}", { name: kitty.name })}
            </button>
          ) : (
            <button
              class="btn-accent px-3 py-1.5 text-sm flex items-center gap-2"
              onClick={() => take(true)}
              disabled={busy || !loaded}
              data-testid="take-control"
            >
              {busy && <span class="spinner" />}
              {t("Take control")}
            </button>
          )}
          <button
            class="btn-ghost p-1.5"
            onClick={() => setExpanded(true)}
            aria-label={t("Enlarge")}
            title={t("Enlarge")}
            data-testid="live-enlarge"
          >
            <IconExpand size={14} />
          </button>
        </div>
      )}
      <div
        ref={surface}
        tabIndex={0}
        class={`live-surface relative flex items-center justify-center outline-none overflow-hidden ${windowed ? "min-h-[10rem] flex-1" : "w-full"} ${control ? "is-control" : ""} ${gesture?.drag ? "is-dragging" : ""} ${!control && loaded ? "is-takeable" : ""}`}
        style={
          windowed
            ? undefined
            : { aspectRatio: dims.w && dims.h ? `${dims.w} / ${dims.h}` : "16 / 10" }
        }
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onContextMenu={(e) => control && e.preventDefault()}
      >
        <div
          class={`live-stage ${loaded ? "" : "invisible absolute"}`}
          style={fit}
          onMouseLeave={onMouseLeave}
          onClick={() => {
            // One click on the picture takes the controls: no button to find first.
            if (!control && loaded && !busy) {
              void take(true);
            }
          }}
        >
          {mode === "rects" && (
            <canvas
              ref={canvas}
              aria-label={t("{name}'s desktop", { name: kitty.name })}
              class="select-none"
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onWheel={onWheel}
              data-testid="live-frame"
              data-mode="rects"
            />
          )}
          {mode !== "rects" && frame && (
            <img
              ref={img}
              src={frame}
              alt={t("{name}'s desktop", { name: kitty.name })}
              class="select-none"
              draggable={false}
              onLoad={(e) => {
                setLoaded(true);
                setDisplayError("");
                setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
              }}
              onError={() => {
                releaseControl();
                setLoaded(false);
                setDisplayError(t("The desktop did not answer"));
                if (mode === "stream") setMode("poll");
              }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onWheel={onWheel}
              data-testid="live-frame"
              data-mode={mode}
            />
          )}
          {gesture && dims.w > 0 && (
            <svg
              class="live-gesture"
              viewBox={`0 0 ${dims.w} ${dims.h}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              data-testid="live-gesture"
            >
              {gesture.drag && (
                <line
                  x1={gesture.from.x}
                  y1={gesture.from.y}
                  x2={gesture.to.x}
                  y2={gesture.to.y}
                  vector-effect="non-scaling-stroke"
                />
              )}
            </svg>
          )}
          {gesture && <span class="live-press" style={pct(gesture.from)} aria-hidden="true" />}
          {gesture?.drag && (
            <span class="live-press is-end" style={pct(gesture.to)} aria-hidden="true" />
          )}
          {rings.map((r) => (
            <span
              key={r.id}
              class={`live-ring is-${r.kind}`}
              style={pct(r)}
              aria-hidden="true"
              data-testid="live-ring"
            >
              {RING_ARROW[r.kind]}
            </span>
          ))}
        </div>
        {!control && loaded && (
          <span class="live-hint" aria-hidden="true">
            {busy ? <span class="spinner" /> : null}
            {t("Click the picture to take control")}
          </span>
        )}
        {!loaded && (
          <div class="text-sm text-[var(--t3)] py-20">
            {displayError ? (
              t("The desktop did not answer")
            ) : (
              <>
                <span class="spinner" /> {t("Connecting to the desktop…")}
              </>
            )}
          </div>
        )}
      </div>
      {control && (
        <div
          class={`live-activity is-${activity.tone} shrink-0`}
          role="status"
          aria-live="polite"
          data-testid="live-activity"
        >
          {activity.tone === "busy" ? <span class="spinner" /> : <span class="live-dot" />}
          <span class="min-w-0 truncate">{activity.text}</span>
        </div>
      )}
      {control && (
        <div class="flex gap-1.5 flex-wrap items-center shrink-0" data-testid="quick-keys">
          {QUICK.map(([label, keys]) => (
            <button
              key={keys}
              class="btn-ghost px-2 py-1 text-xs font-mono"
              onClick={() => {
                if (!flushTyped()) return;
                send("key", { keys });
                surface.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
          <span class="text-xs text-[var(--t3)] ml-auto">
            {t("Click, drag, scroll and type on the picture; Ctrl+V pastes your own text.")}
          </span>
        </div>
      )}
      {control && (
        <div
          class="flex gap-1.5 flex-wrap sm:flex-nowrap items-center shrink-0"
          data-testid="clipboard"
        >
          <input
            class={INPUT}
            value={clip}
            placeholder={t("Text for {name}'s clipboard", { name: kitty.name })}
            aria-label={t("Clipboard")}
            onInput={(e) => setClip((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button
            class="btn-ghost px-2 py-1.5 text-xs whitespace-nowrap"
            onClick={sendClip}
            disabled={!clip}
          >
            {t("Send to {name}", { name: kitty.name })}
          </button>
          <button class="btn-ghost px-2 py-1.5 text-xs whitespace-nowrap" onClick={takeClip}>
            {t("Copy from {name}", { name: kitty.name })}
          </button>
        </div>
      )}
      {clipNote && (
        <p class="text-xs text-[var(--t3)] shrink-0" role="status" data-testid="clip-note">
          {clipNote}
        </p>
      )}
      {!control && (
        <p class="text-xs text-[var(--t3)] shrink-0">
          {t(
            "Take control to click and type in it yourself, for what {name} cannot do alone (a password, a captcha). {name} waits meanwhile.",
            { name: kitty.name },
          )}
        </p>
      )}
      {displayError && (
        <p class="text-sm text-[var(--c-red)] shrink-0" data-testid="live-error">
          {displayError}
        </p>
      )}
      {err && <p class="text-sm text-[var(--c-red)] shrink-0">{err}</p>}
    </>
  );

  if (!windowed) {
    return (
      <div class="live-card flex flex-col gap-2 min-w-0" data-testid="live-desktop">
        {content}
      </div>
    );
  }
  return (
    <div
      class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-6 backdrop"
      onClick={leave}
      data-modal
      data-testid="live-desktop"
    >
      <div
        class="chat-modal w-full max-w-6xl h-full max-h-[56rem] p-3 sm:p-4 flex flex-col gap-3 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={name}
      >
        {content}
      </div>
    </div>
  );
}
