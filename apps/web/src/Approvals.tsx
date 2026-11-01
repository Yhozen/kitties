import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { Approval, ApprovalRule, Kitty } from "./api";
import { actionLabel } from "./friendly";
import { api } from "./api";
import { when } from "./format";
import { t } from "./i18n";
import { IconShield, IconX } from "./icons";
import PixelCat from "./PixelCat";

// WHAT IS WAITING FOR A YES.
//
// A kitty that wants to publish, send or spend does not do it alone until it has earned that:
// the action waits here. A yes runs it, and the result lands in the chat; a no, with a reason,
// goes to the kitty, which learns from it. "Don't ask again" makes it a standing permission.

const INPUT = "w-full px-3 py-2 text-sm";

function statusTag(a: Approval): string {
  if (a.status === "approved") {
    return a.error ? "tag-red" : "tag-green";
  }
  return a.status === "rejected" ? "tag-red" : "tag-amber";
}

function ApprovalCard({
  a,
  kitty,
  onDecided,
  onOpenChat,
}: {
  a: Approval;
  kitty?: Kitty;
  onDecided: () => void;
  onOpenChat: (id: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const decide = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onDecided();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div class="approval" data-testid="approval">
      <div class="flex items-center gap-3 min-w-0">
        <PixelCat
          breed={kitty?.avatar?.breed}
          color={kitty?.avatar?.color}
          mood="thinking"
          size={34}
        />
        <div class="min-w-0 flex-1">
          <div class="text-sm">
            <b>{a.kitty_name}</b> {t("wants to")}{" "}
            <code class="font-mono">
              {a.connector}.{a.action}
            </code>
          </div>
          <div class="text-xs text-[var(--t3)]">{when(a.at)}</div>
        </div>
      </div>
      <p class="approval-summary">{a.summary}</p>
      <details class="text-xs text-[var(--t3)]">
        <summary>{t("the exact request")}</summary>
        <pre class="approval-args">{JSON.stringify(a.args, null, 2)}</pre>
      </details>
      {rejecting ? (
        <div class="mt-2">
          <label class="block text-xs text-[var(--t3)] mb-1" for={"why-" + a.id}>
            {t("Why not? {name} reads this and learns from it.", { name: a.kitty_name })}
          </label>
          <input
            id={"why-" + a.id}
            class={INPUT}
            value={reason}
            onInput={(e) => setReason((e.target as HTMLInputElement).value)}
            placeholder={t("too informal, wrong channel, not today…")}
          />
          <div class="flex gap-2 mt-2 justify-end">
            <button class="btn-ghost px-3 py-1.5 text-xs" onClick={() => setRejecting(false)}>
              {t("Back")}
            </button>
            <button
              class="btn-danger px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() => decide(() => api.reject(a.id, reason.trim()))}
            >
              {t("Reject")}
            </button>
          </div>
        </div>
      ) : (
        <div class="flex gap-2 mt-2 flex-wrap">
          <button
            class="btn-accent px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => decide(() => api.approve(a.id, false))}
          >
            {t("Approve")}
          </button>
          <button
            class="btn-outline px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => decide(() => api.approve(a.id, true))}
            title={t("From now on {name} does this without asking", { name: a.kitty_name })}
          >
            {t("Approve, don't ask again")}
          </button>
          <button
            class="btn-ghost px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            {t("Reject…")}
          </button>
          {a.chat && (
            <button class="btn-ghost px-3 py-1.5 text-xs" onClick={() => onOpenChat(a.chat!)}>
              {t("open chat")}
            </button>
          )}
        </div>
      )}
      {err && <p class="text-sm text-[var(--c-red)] mt-1">{err}</p>}
    </div>
  );
}

// A rule is how an action of a kitty is limited, as the lists say it.
export const RULE_LABEL: Record<string, string> = {
  auto: t("allowed"),
  ask: t("asks first"),
  never: t("never"),
};
const RULE_TAG: Record<string, string> = { auto: "tag-green", ask: "tag-amber", never: "tag-red" };

// ruleTarget says what a rule covers: an action of a connection, or all of it.
export function ruleTarget(r: { connector: string; action: string }): string {
  return r.action === "*" || !r.action
    ? t("anything on {connector}", { connector: r.connector })
    : t("{action} on {connector}", { action: actionLabel(r.action), connector: r.connector });
}

export default function ApprovalsModal({
  kitties,
  onClose,
  onChanged,
  onOpenChat,
}: {
  kitties: Kitty[];
  onClose: () => void;
  onChanged: () => void;
  onOpenChat: (id: string) => void;
}) {
  const [pending, setPending] = useState<Approval[]>([]);
  const [recent, setRecent] = useState<Approval[]>([]);
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [err, setErr] = useState("");
  const byId = new Map(kitties.map((k) => [k.id, k]));
  const load = () => {
    Promise.all([api.approvals("pending"), api.approvals(), api.approvalRules()])
      .then(([p, all, r]) => {
        setPending(p);
        setRecent(all.filter((x) => x.status !== "pending").slice(0, 8));
        setRules(r);
      })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  const changed = () => {
    load();
    onChanged();
  };
  return (
    <div
      class="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4 backdrop"
      onClick={onClose}
      data-modal
    >
      <div
        class="chat-modal w-full max-w-3xl p-5 max-h-[90vh] overflow-y-auto scroll-thin"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-mono text-base tracking-wide flex items-center gap-2">
            <IconShield size={16} /> {t("Approvals")}
          </h2>
          <button
            class="plain p-1 text-[var(--t3)] hover:text-[var(--t1)]"
            onClick={onClose}
            aria-label={t("Close")}
          >
            <IconX />
          </button>
        </div>
        <p class="text-xs text-[var(--t3)] mb-3">
          {t(
            "Actions that reach other people or move money wait here until you say yes. A kitty you keep saying yes to earns the right to do that kind of thing alone: sooner if you are relaxed, later if you are demanding.",
          )}
        </p>
        {err && <p class="text-sm text-[var(--c-red)] mb-2">{err}</p>}
        <div class="section-title !mx-0">{t("Waiting for you")}</div>
        {pending.length === 0 && <p class="text-sm text-[var(--t4)]">{t("Nothing is waiting.")}</p>}
        <div class="flex flex-col gap-3" data-testid="pending">
          {pending.map((a) => (
            <ApprovalCard
              key={a.id}
              a={a}
              kitty={byId.get(a.kitty)}
              onDecided={changed}
              onOpenChat={(id) => {
                onClose();
                onOpenChat(id);
              }}
            />
          ))}
        </div>
        {rules.length > 0 && (
          <>
            <div class="section-title !mx-0 mt-5">{t("Limits")}</div>
            <div class="flex flex-col gap-1" data-testid="rules">
              {rules.map((r) => (
                <div key={r.id} class="flex items-center gap-2 text-sm">
                  <span class={`tag ${RULE_TAG[r.mode]}`}>{RULE_LABEL[r.mode]}</span>
                  <span class="flex-1 truncate">
                    {r.kitty_name || r.kitty} · {ruleTarget(r)}
                  </span>
                  <button
                    class="btn-ghost px-2 py-1 text-xs"
                    onClick={() =>
                      api
                        .removeRule(r.id)
                        .then(changed)
                        .catch((e) => setErr((e as Error).message))
                    }
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        {recent.length > 0 && (
          <>
            <div class="section-title !mx-0 mt-5">{t("Decided")}</div>
            <div class="flex flex-col gap-1" data-testid="decided">
              {recent.map((a) => (
                <div key={a.id} class="flex items-center gap-2 text-sm min-w-0">
                  <span class={`tag ${statusTag(a)}`}>{a.error ? t("failed") : t(a.status)}</span>
                  <span
                    class="flex-1 min-w-0 truncate"
                    title={a.reason || a.error || a.result || a.summary}
                  >
                    {a.kitty_name} · {a.summary}
                  </span>
                  <span class="text-[10px] text-[var(--t4)] font-mono whitespace-nowrap">
                    {when(a.decided_at || a.at)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
