import { useEffect, useState } from "preact/hooks";
import type { ConnectorView, Goal, JournalEntry, Kitty, Limits } from "./api";
import { api } from "./api";
import { when } from "./format";
import { t } from "./i18n";
import { IconClock, IconPlay, IconTarget, IconTrash } from "./icons";
import ActionLimits from "./ActionLimits";
import { Missing, Required } from "./Required";

// WHAT A KITTY DOES ON ITS OWN.
//
// Goals run on a schedule, on a connector's events, or by hand; the journal is the record of
// what happened; the limits and the backup are the safety net. All of it lives in the kitty's
// drawer.

const LABEL = "block text-xs text-[var(--t3)] mb-1 mt-3 uppercase tracking-wider font-mono";
const INPUT = "w-full px-3 py-2 text-sm";

// PRESETS are the schedules most people want, without writing cron.
const PRESETS: { label: string; every: string }[] = [
  { label: "every 15 min", every: "*/15 * * * *" },
  { label: "hourly", every: "@hourly" },
  { label: "daily at 9", every: "@daily" },
  { label: "weekdays at 9", every: "0 9 * * 1-5" },
  { label: "weekly (Mon)", every: "@weekly" },
  { label: "custom", every: "" },
];

// describeEvery says a cron expression in words when it is one of the presets.
export function describeEvery(every?: string): string {
  if (!every) {
    return "";
  }
  const hit = PRESETS.find(
    (p) =>
      p.every === every ||
      (p.every === "@hourly" && every === "0 * * * *") ||
      (p.every === "@daily" && every === "0 9 * * *") ||
      (p.every === "@weekly" && every === "0 9 * * 1"),
  );
  return hit ? t(hit.label) : every;
}

function resultTag(r?: string): string {
  switch (r) {
    case "done":
      return "tag-green";
    case "running":
      return "tag-accent";
    case "blocked":
    case "failed":
    case "escalated":
      return "tag-red";
    case "delegated":
      return "tag-magenta";
    default:
      return "";
  }
}

// How many goals and journal lines show before "show more": the drawer keeps its other rows in
// sight however long these grow.
const FEW_GOALS = 3;
const FEW_LINES = 5;

// MoreLess is the button that opens a list past its first few rows, and closes it again.
function MoreLess({
  total,
  few,
  open,
  onToggle,
  id,
}: {
  total: number;
  few: number;
  open: boolean;
  onToggle: () => void;
  id: string;
}) {
  if (total <= few) {
    return null;
  }
  return (
    <button
      class="btn-ghost px-2 py-1 text-xs mt-2"
      onClick={onToggle}
      aria-expanded={open}
      data-testid={id}
    >
      {open ? t("Show less") : t("Show {n} more", { n: total - few })}
    </button>
  );
}

export function GoalsPanel({
  kitty,
  onOpenChat,
}: {
  kitty: Kitty;
  onOpenChat: (id: string) => void;
}) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [allGoals, setAllGoals] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [preset, setPreset] = useState(PRESETS[2].every);
  const [custom, setCustom] = useState("");
  const [on, setOn] = useState<string[]>([]);
  const load = () => {
    api
      .goals(kitty.id)
      .then(setGoals)
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(() => {
    load();
    api
      .settings()
      .then((s) =>
        setConnectors(
          s.connectors.filter((c) => s.connector_catalog.find((k) => k.name === c.kind)?.inbound),
        ),
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitty.id]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const add = () =>
    act(async () => {
      const every = preset === "" ? custom.trim() : preset;
      await api.addGoal({ kitty: kitty.id, title: title.trim(), text: text.trim(), every, on });
      setAdding(false);
      setTitle("");
      setText("");
      setOn([]);
    });
  return (
    <div>
      <div class="section-title !mx-0 mt-5 flex items-center gap-2">
        <IconTarget size={12} /> {t("Goals")}
      </div>
      {goals.length === 0 && !adding && (
        <p class="text-xs text-[var(--t4)]">
          {t("No goals yet: {name} only works when asked.", { name: kitty.name })}
        </p>
      )}
      <div class="flex flex-col gap-2" data-testid="goals">
        {(allGoals ? goals : goals.slice(0, FEW_GOALS)).map((g) => (
          <div key={g.id} class={`goal ${g.enabled ? "" : "off"}`}>
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-semibold truncate">{g.title}</span>
              {g.from_file && <span class="tag">{t("file")}</span>}
              {g.last_result && (
                <span class={`tag ${resultTag(g.last_result)}`}>{t(g.last_result)}</span>
              )}
              {!g.enabled && <span class="tag tag-amber">{t("paused")}</span>}
            </div>
            <div class="text-xs text-[var(--t3)] mt-0.5 flex flex-wrap gap-x-3">
              {g.every && (
                <span class="inline-flex items-center gap-1">
                  <IconClock size={11} /> {describeEvery(g.every)}
                </span>
              )}
              {g.on && g.on.length > 0 && (
                <span>{t("on events from {names}", { names: g.on.join(", ") })}</span>
              )}
              {g.next_run && g.enabled && g.every && (
                <span>{t("next {time}", { time: when(g.next_run) })}</span>
              )}
              {g.runs > 0 && <span>{t(g.runs === 1 ? "{n} run" : "{n} runs", { n: g.runs })}</span>}
            </div>
            <div class="flex gap-1 mt-1.5 flex-wrap">
              <button
                class="btn-outline px-2 py-1 text-xs flex items-center gap-1"
                onClick={() => act(() => api.runGoal(g.id).then((c) => c && onOpenChat(c)))}
              >
                <IconPlay size={10} /> {t("run now")}
              </button>
              {g.chat && (
                <button class="btn-ghost px-2 py-1 text-xs" onClick={() => onOpenChat(g.chat!)}>
                  {t("open chat")}
                </button>
              )}
              {!g.from_file && (
                <button
                  class="btn-ghost px-2 py-1 text-xs"
                  onClick={() =>
                    act(() =>
                      api.updateGoal(g.id, {
                        title: g.title,
                        text: g.text,
                        every: g.every,
                        on: g.on,
                        enabled: !g.enabled,
                      }),
                    )
                  }
                >
                  {g.enabled ? t("pause") : t("resume")}
                </button>
              )}
              {!g.from_file && (
                <button
                  class="btn-ghost px-2 py-1 text-xs text-[var(--c-red)]"
                  onClick={() => act(() => api.removeGoal(g.id))}
                  aria-label={t("Remove the goal")}
                >
                  <IconTrash size={11} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <MoreLess
        total={goals.length}
        few={FEW_GOALS}
        open={allGoals}
        onToggle={() => setAllGoals(!allGoals)}
        id="goals-more"
      />
      {adding ? (
        <div class="mt-3 p-3 border border-[rgb(var(--accent-rgb)/0.3)] bg-[rgb(var(--accent-rgb)/0.05)]">
          <label class={LABEL}>
            {t("Title")}
            <Required />
          </label>
          <input
            class={INPUT}
            aria-required="true"
            aria-label={t("Title")}
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder={t("Triage the new issues")}
          />
          <label class={LABEL}>{t("What to do (optional)")}</label>
          <textarea
            class={INPUT}
            rows={2}
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            placeholder={t("Read each new issue, label it and answer the easy ones.")}
          />
          <label class={LABEL}>{t("When")}</label>
          <div class="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                class={`${preset === p.every ? "btn-outline" : "btn-ghost"} px-2 py-1 text-xs`}
                onClick={() => setPreset(p.every)}
              >
                {t(p.label)}
              </button>
            ))}
          </div>
          {preset === "" && (
            <input
              class={`${INPUT} font-mono mt-2`}
              value={custom}
              onInput={(e) => setCustom((e.target as HTMLInputElement).value)}
              placeholder={t("cron: minute hour day month weekday (leave empty for events only)")}
            />
          )}
          {connectors.length > 0 && (
            <>
              <label class={LABEL}>{t("Also when these services report something")}</label>
              <div class="flex flex-wrap gap-1">
                {connectors.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    class={`${on.includes(c.name) ? "btn-outline" : "btn-ghost"} px-2 py-1 text-xs`}
                    onClick={() =>
                      setOn(on.includes(c.name) ? on.filter((n) => n !== c.name) : [...on, c.name])
                    }
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              <p class="text-xs text-[var(--t4)] mt-1">
                {t(
                  "A service posts to /v1/hooks/<connector> with the connector's incoming events secret.",
                )}
              </p>
            </>
          )}
          <div class="flex justify-end gap-2 mt-3">
            <button class="btn-ghost px-3 py-1.5 text-xs" onClick={() => setAdding(false)}>
              {t("Cancel")}
            </button>
            <button class="btn-accent px-3 py-1.5 text-xs" disabled={!title.trim()} onClick={add}>
              {t("Add goal")}
            </button>
          </div>
          <Missing items={[!title.trim() && t("the title")]} />
        </div>
      ) : (
        <button class="btn-outline px-3 py-1.5 text-xs mt-2" onClick={() => setAdding(true)}>
          + {t("New goal")}
        </button>
      )}
      {err && <p class="text-sm text-[var(--c-red)] mt-2">{err}</p>}
    </div>
  );
}

const KIND_TAG: Record<string, string> = {
  done: "tag-green",
  run: "tag-accent",
  event: "tag-accent",
  blocked: "tag-red",
  escalated: "tag-red",
  retry: "tag-amber",
  skipped: "tag-amber",
  delegated: "tag-magenta",
  recovered: "tag-green",
  updated: "tag-green",
};

export function JournalPanel({
  kitty,
  onOpenChat,
}: {
  kitty: Kitty;
  onOpenChat: (id: string) => void;
}) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [allLines, setAllLines] = useState(false);
  useEffect(() => {
    api
      .journal(kitty.id, 30)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [kitty.id]);
  return (
    <div>
      <div class="section-title !mx-0 mt-5">{t("Journal")}</div>
      {entries.length === 0 && <p class="text-xs text-[var(--t4)]">{t("Nothing yet.")}</p>}
      <div class="journal" data-testid="journal">
        {(allLines ? entries : entries.slice(0, FEW_LINES)).map((e, i) => (
          <div key={i} class="journal-line">
            <span class="text-[var(--t4)] font-mono text-[10px] whitespace-nowrap">
              {when(e.at)}
            </span>
            <span class={`tag ${KIND_TAG[e.kind] || ""}`}>{t(e.kind)}</span>
            <span class="min-w-0 truncate flex-1" title={e.text}>
              {e.text}
            </span>
            {e.chat && (
              <button
                class="plain text-[var(--color-accent)] text-xs"
                onClick={() => onOpenChat(e.chat!)}
              >
                {t("open")}
              </button>
            )}
          </div>
        ))}
      </div>
      <MoreLess
        total={entries.length}
        few={FEW_LINES}
        open={allLines}
        onToggle={() => setAllLines(!allLines)}
        id="journal-more"
      />
    </div>
  );
}

export function LimitsForm({
  kitty,
  kitties,
  onChanged,
}: {
  kitty: Kitty;
  kitties: Kitty[];
  onChanged: () => void;
}) {
  const l = kitty.limits || {};
  const [limits, setLimits] = useState<Limits>({
    max_tokens: l.max_tokens || 0,
    max_seconds: l.max_seconds || 0,
    max_rounds: l.max_rounds || 0,
    retries: l.retries || 0,
    day_tokens: l.day_tokens || 0,
    day_actions: l.day_actions || 0,
  });
  const [backup, setBackup] = useState(kitty.backup || "");
  const [approvals, setApprovals] = useState(kitty.approvals === "ask" ? "ask" : "");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const set = (k: keyof Limits, v: string) =>
    setLimits({ ...limits, [k]: Math.max(0, parseInt(v || "0", 10) || 0) });
  const save = async () => {
    setErr("");
    try {
      await api.editKitty(kitty.id, { limits, backup, approvals });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const others = kitties.filter((k) => k.id !== kitty.id);
  return (
    <div>
      <div class="section-title !mx-0 mt-5">{t("Limits & backup")}</div>
      <p class="text-xs text-[var(--t4)]">
        {t(
          "How much one task may spend before {name} stops and says so, and how much it may spend in a day. Leave a box empty for the default.",
          { name: kitty.name },
        )}
      </p>
      <div class="grid grid-cols-2 gap-x-3">
        {(
          [
            ["max_tokens", t("Tokens per task")],
            ["max_seconds", t("Seconds per task")],
            ["max_rounds", t("Rounds per task")],
            ["retries", t("Retries (another way)")],
            ["day_tokens", t("Tokens per day")],
            ["day_actions", t("Actions per day")],
          ] as [keyof Limits, string][]
        ).map(([k, label]) => (
          <div key={k}>
            <label class={LABEL} for={"limit-" + k}>
              {label}
            </label>
            <input
              id={"limit-" + k}
              class={`${INPUT} font-mono`}
              type="number"
              min={0}
              value={limits[k] || ""}
              placeholder={k.startsWith("day_") ? t("no limit") : t("default")}
              onInput={(e) => set(k, (e.target as HTMLInputElement).value)}
            />
          </div>
        ))}
      </div>
      <label class={LABEL} for="limit-backup">
        {t("Backup (takes over a task {name} gives up on)", { name: kitty.name })}
      </label>
      <select
        id="limit-backup"
        class={INPUT}
        value={backup}
        onChange={(e) => setBackup((e.target as HTMLSelectElement).value)}
      >
        <option value="">{t("nobody: ask me instead")}</option>
        {others.map((k) => (
          <option key={k.id} value={k.name}>
            {k.name}
          </option>
        ))}
      </select>
      <label class={LABEL} for="limit-approvals">
        {t("When it wants to publish, send or spend")}
      </label>
      <select
        id="limit-approvals"
        class={INPUT}
        value={approvals}
        onChange={(e) => setApprovals((e.target as HTMLSelectElement).value as "ask" | "")}
      >
        <option value="">{t("act on its own, as far as the account allows")}</option>
        <option value="ask">{t("ask me first (until I trust it with that)")}</option>
      </select>
      <div class="flex items-center gap-2 mt-3">
        <button class="btn-outline px-3 py-1.5 text-xs" onClick={save}>
          {t("Save limits")}
        </button>
        {saved && <span class="tag tag-green">{t("saved")}</span>}
      </div>
      {err && <p class="text-sm text-[var(--c-red)] mt-2">{err}</p>}
      <ActionLimits kitty={kitty} />
    </div>
  );
}
