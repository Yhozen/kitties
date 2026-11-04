import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Kitty, Session, Step, Turn } from "./api";
import { api, shotData, shotURL } from "./api";
import { inline, stepArgs, stepSentence, when } from "./format";
import { actionLabel, plainError } from "./friendly";
import { gatewayText } from "./gatewayText";
import { t } from "./i18n";
import { useTechDetails } from "./prefs";
import PixelCat, { type Mood } from "./PixelCat";
import ConnectorLogo from "./ConnectorLogo";
import { IconCamera, IconHand, IconMonitor, IconShield, IconThumbDown, IconThumbUp } from "./icons";
import { RULE_LABEL, ruleTarget } from "./Approvals";
import HelpModal from "./Help";
import LiveDesktop from "./LiveDesktop";

function Text({ text }: { text: string }) {
  return (
    <div class="text">
      {inline(text).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : part.t === "b" ? (
          <strong key={i}>{part.v}</strong>
        ) : (
          <code key={i}>{part.v}</code>
        ),
      )}
    </div>
  );
}

// Shot loads a screenshot (through the API inside Wails) and shows it as a thumbnail.
export function Shot({
  path,
  big,
  latest,
  onOpen,
}: {
  path: string;
  big?: boolean;
  // latest is the picture the desktop column keeps in view: as wide as the column.
  latest?: boolean;
  onOpen?: (src: string) => void;
}) {
  const [src, setSrc] = useState<string>("");
  // A new path (a refresh) keeps showing the picture it has until the next one is ready to
  // paint: the box never goes blank in between, and a refresh that fails leaves the last picture.
  useEffect(() => {
    let alive = true;
    shotData(path)
      .then(
        (s) =>
          new Promise<string>((done) => {
            const img = new Image();
            img.onload = img.onerror = () => done(s);
            img.src = s;
          }),
      )
      .then((s) => alive && setSrc(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);
  if (!src) {
    return <div class={big ? "live-shot" : `shot-thumb ${latest ? "shot-latest" : ""}`} />;
  }
  if (big) {
    return <img class="live-shot" src={src} alt={t("The kitty's display")} />;
  }
  return (
    <button
      class={`plain shot-thumb ${latest ? "shot-latest" : ""}`}
      onClick={() => onOpen?.(src)}
      aria-label={t("Open the screenshot")}
    >
      <img src={src} alt="" class="w-full h-full object-cover" />
    </button>
  );
}

function StepRow({
  step,
  chat,
  onOpen,
  folded,
  hero,
}: {
  step: Step;
  chat: string;
  onOpen: (src: string) => void;
  // folded is a step whose screenshot is not the latest one: it stays shut until asked for.
  folded?: boolean;
  // hero is the step of the screenshot the desktop column shows big: its row does not repeat it.
  hero?: boolean;
}) {
  const tech = useTechDetails();
  const [open, setOpen] = useState(false);
  const cls = step.error ? "failed" : step.action === "done" ? "done" : "";
  // The step reads as a sentence; what it did exactly (coordinates, the command, the result) is
  // on hover, or written out with the technical details on.
  const args = stepArgs(step.action, step.args);
  const result = step.action !== "done" ? step.result?.split("\n")[0].slice(0, 120) : "";
  const detail = [step.action, args, result].filter(Boolean).join(" · ");
  return (
    <div class="step" title={detail}>
      <span class={`what ${cls}`} aria-hidden="true" />
      <span class="how">
        {stepSentence(step.action, step.args)}
        {tech && (
          <code class="tech" data-testid="step-detail">
            {" "}
            {detail}
          </code>
        )}
        {step.error && (
          <span class="text-[var(--c-red)]">
            {" "}
            — {t("it did not work: {error}", { error: tech ? step.error : plainError(step.error) })}
          </span>
        )}
      </span>
      {step.shot && folded && !hero && (
        <button
          class="plain shot-fold"
          aria-expanded={open}
          aria-label={open ? t("Hide the screenshot") : t("Show the screenshot")}
          title={open ? t("Hide the screenshot") : t("Show the screenshot")}
          onClick={() => setOpen(!open)}
        >
          <IconCamera size={13} />
        </button>
      )}
      {step.shot && !hero && (!folded || open) && (
        <div class="shot">
          <Shot path={`/v1/chats/${chat}/shots/${step.shot}`} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

// The steps of a turn that has any, and the position of the step with its latest screenshot.
const hasSteps = (turn: Turn) => (turn.steps?.length ?? 0) > 0;
const lastShotIndex = (turn: Turn) => (turn.steps || []).map((s) => !!s.shot).lastIndexOf(true);

// Desk is the second column when a kitty works on its desktop: the steps of one task and the
// latest screenshot, big and fixed; the earlier ones stay folded so the column is not all pictures.
function Desk({
  turns,
  chat,
  kitties,
  picked,
  onPick,
  onOpen,
}: {
  turns: Turn[];
  chat: string;
  kitties: Map<string, Kitty>;
  picked: number | null;
  onPick: (i: number) => void;
  onOpen: (src: string) => void;
}) {
  const tasks = turns.map((turn, i) => (hasSteps(turn) ? i : -1)).filter((i) => i >= 0);
  const index = picked !== null && tasks.includes(picked) ? picked : tasks[tasks.length - 1];
  const turn = turns[index];
  const steps = turn.steps || [];
  // The steps with a screenshot: the big picture is the latest unless the person walked back
  // (with the arrows, or ← and →); a new picture brings it forward again.
  const withShot = steps.map((st, i) => (st.shot ? i : -1)).filter((i) => i >= 0);
  const [back, setBack] = useState<number | null>(null);
  useEffect(() => setBack(null), [index, withShot.length]);
  const at =
    back !== null && withShot.includes(back) ? back : (withShot[withShot.length - 1] ?? -1);
  const shot = at;
  const walk = (by: number) => {
    const n = withShot.indexOf(at) + by;
    if (n >= 0 && n < withShot.length) {
      setBack(withShot[n]);
    }
  };
  const list = useRef<HTMLElement>(null);
  // A task that goes on keeps its newest step in view.
  useEffect(() => {
    if (turn.working && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
    }
  }, [steps.length, turn.working, index]);
  const who = (i: number) =>
    (turns[i].kitty && kitties.get(turns[i].kitty!)?.name) || turns[i].from;
  return (
    <aside
      class="conv-desk"
      ref={list}
      aria-label={t("Desktop")}
      data-testid="desk"
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || e.altKey || e.ctrlKey || e.metaKey) {
          return;
        }
        if (e.key === "ArrowLeft") {
          walk(-1);
        } else if (e.key === "ArrowRight") {
          walk(1);
        }
      }}
    >
      <header class="desk-head">
        <IconMonitor size={14} />
        <span class="flex-1">{t("Desktop")}</span>
        {turn.working && <span class="spinner" aria-label={t("working on its computer…")} />}
      </header>
      {tasks.length > 1 && (
        <div class="desk-tasks" role="tablist" aria-label={t("Tasks")}>
          {tasks.map((i, n) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === index}
              class={`plain desk-task ${i === index ? "on" : ""}`}
              onClick={() => onPick(i)}
            >
              {n + 1} · {who(i)}
            </button>
          ))}
        </div>
      )}
      {shot >= 0 && (
        <div
          class="desk-hero"
          data-testid="desk-latest"
          tabIndex={0}
          aria-label={t("Screenshots: use the left and right arrow keys")}
        >
          <Shot latest path={`/v1/chats/${chat}/shots/${steps[shot].shot}`} onOpen={onOpen} />
          {withShot.length > 1 && (
            <div class="desk-walk" data-testid="desk-walk">
              <button
                class="plain"
                aria-label={t("Previous screenshot")}
                disabled={withShot.indexOf(at) === 0}
                onClick={() => walk(-1)}
              >
                ‹
              </button>
              <span>
                {withShot.indexOf(at) + 1} / {withShot.length}
              </span>
              <button
                class="plain"
                aria-label={t("Next screenshot")}
                disabled={withShot.indexOf(at) === withShot.length - 1}
                onClick={() => walk(1)}
              >
                ›
              </button>
            </div>
          )}
        </div>
      )}
      <div class="trail" aria-label={t("steps")}>
        {steps.map((s, i) => (
          <StepRow
            key={i}
            step={s}
            chat={chat}
            onOpen={onOpen}
            folded={i !== shot}
            hero={i === shot}
          />
        ))}
      </div>
      {!turn.working && steps.filter((s) => s.shot).length > 1 && (
        <ReplayButtons chat={chat} index={index} onOpen={onOpen} />
      )}
    </aside>
  );
}

function isSafeReplaySrc(src: string): boolean {
  if (src.startsWith("data:image/")) {
    return true;
  }
  try {
    const u = new URL(src, location.href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ReplayButtons make a task's screenshots into an animated GIF the person can watch and keep.
function ReplayButtons({
  chat,
  index,
  onOpen,
}: {
  chat: string;
  index: number;
  onOpen: (src: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const film = async (what: "watch" | "save") => {
    setBusy(true);
    setErr("");
    try {
      const src = await shotData(`/v1/chats/${chat}/turns/${index}/replay.gif`, "image/gif");
      if (!isSafeReplaySrc(src)) {
        throw new Error("unsafe replay source");
      }
      if (what === "watch") {
        onOpen(src);
      } else {
        const a = document.createElement("a");
        a.href = src;
        a.download = "kitty-task.gif";
        a.click();
      }
    } catch {
      setErr(t("The film could not be made."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex items-center gap-2 mt-2" data-testid="replay">
      <button class="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => film("watch")}>
        ▶ {t("Watch it as a GIF")}
      </button>
      <button class="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => film("save")}>
        {t("Save the GIF")}
      </button>
      {err && <span class="text-xs text-[var(--c-red)]">{err}</span>}
    </div>
  );
}

function turnMood(turn: Turn, latest: boolean): Mood {
  if (turn.working) {
    return "working";
  }
  if (turn.text.includes("could not answer") || turn.text.includes("could not finish")) {
    return "error";
  }
  if (turn.steps?.some((s) => s.action === "done")) {
    return latest ? "happy" : "idle";
  }
  return latest ? "talking" : "idle";
}

// LimitNote shows a limit the kitty set on itself because the person asked, with a way to take
// it back: undoing puts back the mode there was before (none, for a new limit).
function LimitNote({
  kitty,
  limit,
}: {
  kitty: string;
  limit: { connector: string; action: string; mode: string; previous?: string };
}) {
  const [state, setState] = useState<"" | "busy" | "undone">("");
  const [err, setErr] = useState("");
  const target = ruleTarget(limit);
  const undo = async () => {
    setState("busy");
    setErr("");
    try {
      const action = limit.action === "*" ? "" : limit.action;
      await api.setRule(
        kitty,
        limit.connector,
        action,
        (limit.previous || "") as "ask" | "never" | "",
      );
      setState("undone");
    } catch (e) {
      setErr((e as Error).message);
      setState("");
    }
  };
  return (
    <div class="limit-note" data-testid="limit-note">
      <IconShield size={13} />
      <span class="flex-1">
        {limit.mode
          ? t("Limit set: {target} · {mode}", {
              target,
              mode: RULE_LABEL[limit.mode] || limit.mode,
            })
          : t("Limit lifted: {target}", { target })}
        {state === "undone" && <span class="text-[var(--t3)]"> · {t("undone")}</span>}
        {err && <span class="text-[var(--c-red)]"> · {err}</span>}
      </span>
      {state !== "undone" && (
        <button
          class="btn-ghost px-2 py-1 text-xs"
          disabled={state === "busy"}
          onClick={undo}
          data-testid="limit-undo"
        >
          {t("Undo")}
        </button>
      )}
    </div>
  );
}

// Feedback is the thumbs under what a kitty said: up is kept, down asks for a word on why. They
// teach the kitty what the person likes and how demanding they are.
function Feedback({ chat, index, current }: { chat: string; index: number; current: string }) {
  const [rating, setRating] = useState(current);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => setRating(current), [current]);
  const send = async (r: "up" | "down" | "", n = "") => {
    setErr("");
    try {
      await api.feedback(chat, index, r, n);
      setRating(r);
      setAsking(false);
      setNote("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <span class="feedback" data-testid="feedback">
      <button
        class={`plain fb ${rating === "up" ? "on up" : ""}`}
        aria-label={t("Good answer")}
        aria-pressed={rating === "up"}
        onClick={() => send(rating === "up" ? "" : "up")}
      >
        <IconThumbUp size={13} />
      </button>
      <button
        class={`plain fb ${rating === "down" ? "on down" : ""}`}
        aria-label={t("Not good")}
        aria-pressed={rating === "down"}
        onClick={() => (rating === "down" ? send("") : setAsking(true))}
      >
        <IconThumbDown size={13} />
      </button>
      {asking && (
        <span class="feedback-ask">
          <input
            value={note}
            aria-label={t("What was wrong")}
            placeholder={t("what was wrong? (it learns from this)")}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && send("down", note.trim())}
          />
          <button class="btn-ghost px-2 py-0.5 text-xs" onClick={() => send("down", note.trim())}>
            {t("send")}
          </button>
        </span>
      )}
      {err && <span class="text-[var(--c-red)] text-xs">{err}</span>}
    </span>
  );
}

function TurnCard({
  turn,
  index,
  chat,
  user,
  kitty,
  latest,
  onDesk,
  onHelp,
  onContinue,
}: {
  turn: Turn;
  index: number;
  chat: string;
  user: string;
  kitty?: Kitty;
  latest: boolean;
  // onDesk shows the steps of this turn in the desktop column.
  onDesk: (index: number) => void;
  // onHelp opens the kitty's desktop with the controls, when it asked for help.
  onHelp?: () => void;
  // onContinue has a task that stopped on its budget go on from where it was.
  onContinue?: () => void;
}) {
  const mine = turn.from === "user";
  // The scheduler's wake-up call and the answer to an approval read like the person's side,
  // without a cat.
  const scheduler = turn.from === "scheduler";
  const approval = turn.from === "approval";
  const system = scheduler || approval;
  const tech = useTechDetails();
  return (
    <div
      class={`msg ${mine || system ? "user" : "agent"} ${scheduler ? "scheduler" : ""} ${approval ? "approval-turn" : ""} ${turn.working ? "working" : ""} ${turn.needs_help ? "needs-help" : ""}`}
      data-who={mine ? user : system ? turn.from : turn.from}
    >
      {!mine && !system && (
        <span class="msg-cat">
          <PixelCat
            breed={kitty?.avatar?.breed}
            color={kitty?.avatar?.color}
            mood={turn.needs_help ? "error" : turnMood(turn, latest)}
            size={40}
          />
        </span>
      )}
      {turn.needs_help && (
        <div class="help-line">
          <IconHand size={14} /> {t("{name} needs your help with this one.", { name: turn.from })}
        </div>
      )}
      {turn.text && <Text text={mine ? turn.text : gatewayText(turn.text)} />}
      {turn.kitty &&
        turn.limits?.map((l, i) => <LimitNote key={i} kitty={turn.kitty!} limit={l} />)}
      {tech && turn.detail && (
        <pre class="tech-detail" data-testid="turn-detail">
          {turn.detail}
        </pre>
      )}
      {turn.steps && turn.steps.length > 0 && (
        <button
          class="plain desk-link"
          onClick={() => onDesk(index)}
          data-testid="desk-link"
          title={t("Show it on the desktop")}
        >
          <IconMonitor size={12} />
          {t("{n} steps on the desktop", { n: turn.steps.length })}
        </button>
      )}
      {(turn.resumable || turn.interrupted) && !turn.working && latest && onContinue && (
        <div class="callout flex items-center gap-2 mt-2" data-testid="resume-callout">
          <span class="flex-1">
            {turn.interrupted
              ? t(
                  "The gateway restarted during this task. Review its last actions before continuing.",
                )
              : t("{name} ran out of budget for this task; it can go on from where it was.", {
                  name: kitty?.name || t("The kitty"),
                })}
          </span>
          <button class="btn-accent px-3 py-1.5 text-sm" onClick={onContinue} data-testid="resume">
            {t("Continue")}
          </button>
        </div>
      )}
      {turn.working && turn.steps?.[turn.steps.length - 1]?.action === "ask_help" && onHelp && (
        <div class="callout callout-warn flex items-center gap-2 mt-2" data-testid="help-callout">
          <span class="flex-1">
            {t("{name} is waiting for you on its desktop.", {
              name: kitty?.name || t("The kitty"),
            })}
          </span>
          <button
            class="btn-accent px-3 py-1.5 text-sm"
            onClick={onHelp}
            data-testid="help-take-control"
          >
            {t("Take control")}
          </button>
        </div>
      )}
      {turn.working && (
        <div class="working-line">
          <span class="spinner" /> {t("working on its computer…")}
        </div>
      )}
      {(turn.calls?.length || turn.usage?.input || turn.artifacts?.length || !mine) && (
        <div class="meta">
          <span
            title={
              turn.usage && (turn.usage.input || turn.usage.output)
                ? t("{input} → {output} tokens", {
                    input: turn.usage.input,
                    output: turn.usage.output,
                  })
                : undefined
            }
          >
            {when(turn.at)}
          </span>
          {turn.calls?.map((c, i) => (
            <span
              key={i}
              class={`tag tag-logo ${c.error ? "tag-red" : "tag-accent"}`}
              title={tech ? c.error || c.output : c.error ? plainError(c.error) : undefined}
            >
              {c.kind && <ConnectorLogo kind={c.kind} size={12} mono />}
              {c.name}
            </span>
          ))}
          {tech && turn.usage && (turn.usage.input || turn.usage.output) ? (
            <span data-testid="tokens">
              {t("{input}→{output} tokens", { input: turn.usage.input, output: turn.usage.output })}
            </span>
          ) : null}
          {turn.approvals?.map((a) => (
            <a key={a.id} class="tag tag-amber tag-logo" href="#new-approvals" title={a.summary}>
              <IconShield size={11} />{" "}
              {t("waiting for your yes: {action} ({connector})", {
                action: actionLabel(a.action),
                connector: a.connector,
              })}
            </a>
          ))}
          {turn.delegations?.map((d, i) => (
            <a
              key={"d" + i}
              class={`tag ${d.error ? "tag-red" : "tag-magenta"}`}
              href={`#chat/${d.chat}`}
              title={d.error || d.result || d.task}
            >
              → {d.kitty}
            </a>
          ))}
          {turn.skills?.map((n) => (
            <span key={"s" + n} class="tag tag-amber">
              {t("skill · {name}", { name: n })}
            </span>
          ))}
          {turn.artifacts?.map((n) => (
            <a
              key={"a" + n}
              class="tag tag-green"
              href={shotURL(`/v1/artifacts/${encodeURIComponent(n)}`)}
              target="_blank"
            >
              ↓ {n}
            </a>
          ))}
          {!mine && !system && turn.kitty && !turn.working && (
            <Feedback chat={chat} index={index} current={turn.feedback || ""} />
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  session: Session | null;
  // onSend posts a message in the chat (the Continue button of a task stopped on its budget).
  onSend?: (text: string) => void;
  kitties: Kitty[];
  user: string;
  // pending is the message being sent, until the chat has it; waiting shows the kitties
  // thinking until one of them is at work.
  pending: string | null;
  waiting?: boolean;
}

export default function Conversation({ session, kitties, user, pending, waiting, onSend }: Props) {
  const byId = new Map(kitties.map((k) => [k.id, k]));
  const [zoom, setZoom] = useState<string>("");
  // helping is the kitty whose desktop is open because it asked for help.
  const [helping, setHelping] = useState<Kitty | null>(null);
  // The requests for help the person put off, by the step that asked: a new request opens again.
  const [later, setLater] = useState<Record<string, boolean>>({});
  const end = useRef<HTMLDivElement>(null);
  const count = session?.turns?.length ?? 0;
  // With a task on a desktop the chat has two columns: what the kitty says, and what it does.
  // On a phone they are two tabs, and a strip under the chat keeps the latest picture in view.
  const [tab, setTab] = useState<"chat" | "desk">("chat");
  // picked is the task the person chose to look at; none follows the latest one.
  const [picked, setPicked] = useState<number | null>(null);
  const all = session?.turns || [];
  const tasks = all.map((turn, i) => (hasSteps(turn) ? i : -1)).filter((i) => i >= 0);
  const split = tasks.length > 0;
  const lastTask = tasks[tasks.length - 1] ?? -1;
  // The width of the desktop column in a window, kept in this browser.
  const [deskW, setDeskW] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem("kitties.desk")) || null;
    } catch {
      return null;
    }
  });
  const conv = useRef<HTMLDivElement>(null);
  const resize = (w: number | null) => {
    const room = conv.current?.clientWidth ?? 1200;
    const next = w === null ? null : Math.round(Math.max(300, Math.min(w, 900, room * 0.7)));
    setDeskW(next);
    try {
      localStorage.setItem("kitties.desk", next ? String(next) : "");
    } catch {
      /* kept for this visit only */
    }
  };
  // On a phone, the answer is what the person wants when a task ends: the desktop tab gives the
  // chat back then.
  const running = lastTask >= 0 && !!all[lastTask]?.working;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      setTab("chat");
    }
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    setPicked(null);
    if (lastTask < 0) {
      setTab("chat");
    }
  }, [lastTask, session?.id]);
  // Escape closes a screenshot opened big, like a click on it does.
  useLayoutEffect(() => {
    if (!zoom) {
      return;
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom("");
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [zoom]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count, pending, session?.id]);

  if (!session) {
    return (
      <main class="flex-1 flex items-center justify-center p-6">
        <div class="empty-card max-w-md p-6 text-center">
          <div class="text-3xl mb-2">🐱</div>
          <h2 class="font-mono text-lg mb-1">{t("No chat open")}</h2>
          <p class="text-sm text-[var(--t3)]">
            {t(
              "Pick a chat on the left, or start one with the kitties you want in it. In a group, write @name to pick who answers.",
            )}
          </p>
        </div>
      </main>
    );
  }
  const showDesk = (i: number) => {
    setPicked(i);
    setTab("desk");
  };
  const strip = split ? all[picked !== null && tasks.includes(picked) ? picked : lastTask] : null;
  const stripShot = strip ? lastShotIndex(strip) : -1;
  const stripStep = strip?.steps?.[strip.steps.length - 1];
  return (
    <div
      ref={conv}
      class={`conv ${split ? "conv-split" : ""} tab-${tab}`}
      style={deskW ? { "--desk-w": `${deskW}px` } : undefined}
    >
      {split && (
        <div class="conv-tabs" role="tablist">
          {(["chat", "desk"] as const).map((id) => (
            <button
              key={id}
              role="tab"
              class={`plain conv-tab ${tab === id ? "on" : ""}`}
              aria-selected={tab === id}
              data-testid={`tab-${id}`}
              onClick={() => setTab(id)}
            >
              {id === "chat" ? t("Chat") : t("Desktop")}
              {id === "desk" && strip?.working && <span class="spinner" />}
            </button>
          ))}
        </div>
      )}
      <div class="conv-chat">
        <div
          class="flex-1 overflow-y-auto px-4 sm:px-8 py-5 flex flex-col gap-3 scroll-thin"
          role="log"
        >
          {(session.turns || []).length === 0 && !pending && (
            <div class="empty-card max-w-md mx-auto mt-10 p-5 text-center" data-testid="chat-empty">
              <div class="text-2xl mb-1">👋</div>
              <p class="text-sm text-[var(--t2)]">
                {session.members.length > 1
                  ? t(
                      "Say hello to the team, or give them a task. Write @name to pick who answers.",
                    )
                  : t("Say hello, ask a question, or give it a task to work on.")}
              </p>
            </div>
          )}
          {(session.turns || []).map((turn, i, all) => (
            <TurnCard
              key={i}
              turn={turn}
              index={i}
              chat={session.id}
              user={user}
              kitty={turn.kitty ? byId.get(turn.kitty) : undefined}
              latest={i >= all.length - session.members.length}
              onDesk={showDesk}
              onHelp={() => {
                const k = turn.kitty ? byId.get(turn.kitty) : undefined;
                if (k) {
                  setHelping(k);
                }
              }}
              onContinue={
                onSend
                  ? () => {
                      const k = turn.kitty ? byId.get(turn.kitty) : undefined;
                      const who = k && session.members.length > 1 ? `@${k.name} ` : "";
                      onSend(
                        who +
                          t(
                            turn.interrupted
                              ? "Check which actions completed before the interruption, then continue. Do not repeat actions that already succeeded."
                              : "Continue where you left off.",
                          ),
                      );
                    }
                  : undefined
              }
            />
          ))}
          {pending && (
            <div class="msg user" data-who={user}>
              <Text text={pending} />
            </div>
          )}
          {(pending || waiting) && (
            <>
              <div class="flex items-end gap-2 px-2 mt-2" data-testid="thinking">
                {session.members.map((id) => {
                  const k = byId.get(id);
                  return k ? (
                    <PixelCat
                      key={id}
                      breed={k.avatar?.breed}
                      color={k.avatar?.color}
                      mood="thinking"
                      size={36}
                    />
                  ) : null;
                })}
                <span class="working-line !mt-0">
                  <span class="spinner" /> {t("thinking…")}
                </span>
              </div>
            </>
          )}
          <div ref={end} />
          {session &&
            !helping &&
            (session.turns || []).map((turn, i) => {
              const last = turn.steps?.[turn.steps.length - 1];
              const k = turn.kitty ? byId.get(turn.kitty) : undefined;
              const key = `${session.id}:${i}:${turn.steps?.length}`;
              return turn.working && last?.action === "ask_help" && k && !later[key] ? (
                <HelpModal
                  key={key}
                  kitty={k}
                  chat={session.id}
                  turn={i}
                  step={last}
                  onTakeControl={() => {
                    setLater({ ...later, [key]: true });
                    setHelping(k);
                  }}
                  onClose={() => setLater({ ...later, [key]: true })}
                />
              ) : null;
            })}
          {helping && (
            <LiveDesktop
              key={helping.id}
              kitty={byId.get(helping.id) || helping}
              autoControl
              onClose={() => setHelping(null)}
            />
          )}
        </div>
        {strip && stripStep && (
          <div class="desk-strip" data-testid="desk-strip">
            {stripShot >= 0 && (
              <Shot
                path={`/v1/chats/${session.id}/shots/${strip.steps![stripShot].shot}`}
                onOpen={setZoom}
              />
            )}
            <button class="plain desk-strip-text" onClick={() => setTab("desk")}>
              {strip.working && <span class="spinner" />}
              <span class="flex-1">{stepSentence(stripStep.action, stripStep.args)}</span>
              <IconMonitor size={14} />
            </button>
          </div>
        )}
      </div>
      {split && (
        <div
          class="conv-bar"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Resize the desktop column")}
          aria-valuenow={deskW ?? undefined}
          tabIndex={0}
          data-testid="desk-bar"
          title={t("Drag to resize; double-click to reset")}
          onDblClick={() => resize(null)}
          onPointerDown={(e) => (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)}
          onPointerMove={(e) => {
            if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
              const box = conv.current?.getBoundingClientRect();
              box && resize(box.right - e.clientX);
            }
          }}
          onKeyDown={(e) => {
            const now =
              deskW ??
              (conv.current?.querySelector(".conv-desk") as HTMLElement | null)?.offsetWidth ??
              450;
            if (e.key === "ArrowLeft") {
              resize(now + 24);
            } else if (e.key === "ArrowRight") {
              resize(now - 24);
            }
          }}
        />
      )}
      {split && (
        <Desk
          turns={all}
          chat={session.id}
          kitties={byId}
          picked={picked}
          onPick={setPicked}
          onOpen={setZoom}
        />
      )}
      {zoom && (
        <div
          class="fixed inset-0 z-40 bg-black/80 flex items-center justify-center p-6 backdrop"
          onClick={() => setZoom("")}
          data-testid="zoom"
        >
          <img
            src={zoom}
            alt={t("Screenshot")}
            class="max-w-full max-h-full border border-[var(--neon-cyan)] shadow-[var(--glow-cyan)]"
          />
        </div>
      )}
    </div>
  );
}
