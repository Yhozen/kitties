import { useEffect, useState } from "preact/hooks";
import type { ApprovalRule, Kitty, SettingsView } from "./api";
import { api } from "./api";
import { RULE_LABEL, ruleTarget } from "./Approvals";
import { actionLabel, mayUse } from "./friendly";
import { t } from "./i18n";
import { Missing, Required } from "./Required";

const LABEL = "block text-xs text-[var(--t3)] mb-1 mt-3 uppercase tracking-wider font-mono";
const INPUT = "w-full px-3 py-2 text-sm";
const TAG: Record<string, string> = { auto: "tag-green", ask: "tag-amber", never: "tag-red" };

// ActionLimits is a kitty's limiter: the actions it asks about first or never does. Nothing is
// limited until the person says so; the kitty adds a limit itself when the person asks it to in a
// chat, and here they are seen, added and taken away.
export default function ActionLimits({ kitty }: { kitty: Kitty }) {
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [view, setView] = useState<SettingsView | null>(null);
  const [conn, setConn] = useState("");
  const [action, setAction] = useState("");
  const [mode, setMode] = useState<"ask" | "never">("ask");
  const [err, setErr] = useState("");
  const load = () =>
    api
      .approvalRules()
      .then((all) => setRules(all.filter((r) => r.kitty === kitty.id)))
      .catch(() => setRules([]));
  useEffect(() => {
    load();
    api
      .settings()
      .then(setView)
      .catch(() => setView(null));
  }, [kitty.id]);
  const mine = (view?.connectors || []).filter((c) => mayUse(kitty.connectors, c.name));
  const kind = view?.connector_catalog.find(
    (k) => k.name === mine.find((c) => c.name === conn)?.kind,
  );
  const add = async () => {
    setErr("");
    try {
      await api.setRule(kitty.id, conn, action, mode);
      setAction("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = (id: string) =>
    api
      .removeRule(id)
      .then(load)
      .catch((e) => setErr((e as Error).message));
  return (
    <div data-testid="action-limits">
      <div class="section-title !mx-0 mt-5">{t("Action limits")}</div>
      <p class="text-xs text-[var(--t4)]">
        {t(
          "{name} does what its connections allow. Tell it in a chat (“ask me before posting”) and it adds the limit here, or add one yourself.",
          { name: kitty.name },
        )}
      </p>
      {rules.length > 0 && (
        <div class="flex flex-col gap-1 mt-2" data-testid="kitty-rules">
          {rules.map((r) => (
            <div key={r.id} class="flex items-center gap-2 text-sm">
              <span class={`tag ${TAG[r.mode]}`}>{RULE_LABEL[r.mode]}</span>
              <span class="flex-1 truncate">{ruleTarget(r)}</span>
              <button class="btn-ghost px-2 py-1 text-xs" onClick={() => remove(r.id)}>
                {t("remove")}
              </button>
            </div>
          ))}
        </div>
      )}
      {mine.length > 0 && (
        <>
          <div class="grid grid-cols-3 gap-2 items-end">
            <div>
              <label class={LABEL} for="rule-connector">
                {t("Connection")}
                <Required />
              </label>
              <select
                id="rule-connector"
                class={INPUT}
                aria-required="true"
                value={conn}
                onChange={(e) => {
                  setConn((e.target as HTMLSelectElement).value);
                  setAction("");
                }}
              >
                <option value="">{t("pick one")}</option>
                {mine.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label}
                    {c.name !== c.kind ? ` (${c.name})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label class={LABEL} for="rule-action">
                {t("Action")}
              </label>
              <select
                id="rule-action"
                class={INPUT}
                value={action}
                onChange={(e) => setAction((e.target as HTMLSelectElement).value)}
              >
                <option value="">{t("everything")}</option>
                {(kind?.actions || []).map((a) => (
                  <option key={a.name} value={a.name}>
                    {actionLabel(a.name)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label class={LABEL} for="rule-mode">
                {t("It")}
              </label>
              <select
                id="rule-mode"
                class={INPUT}
                value={mode}
                onChange={(e) => setMode((e.target as HTMLSelectElement).value as "ask" | "never")}
              >
                <option value="ask">{t("asks me first")}</option>
                <option value="never">{t("never does it")}</option>
              </select>
            </div>
          </div>
          <button
            class="btn-outline px-3 py-1.5 text-xs mt-2"
            disabled={!conn}
            onClick={add}
            data-testid="add-limit"
          >
            {t("Add limit")}
          </button>
          <Missing items={[!conn && t("a connection")]} />
        </>
      )}
      {err && <p class="text-sm text-[var(--c-red)] mt-2">{err}</p>}
    </div>
  );
}
