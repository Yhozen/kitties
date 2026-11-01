import { useEffect, useState } from "preact/hooks";
import { api, ApiError, errText, type Recovery } from "./api";
import { ask } from "./Confirm";
import { when } from "./format";
import { t } from "./i18n";

export default function Recoveries() {
  const [points, setPoints] = useState<Recovery[]>([]);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setPoints(await api.recoveries());
      setError("");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) setSupported(false);
      else setError(errText(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (!supported) return null;
  const purge = async (point: Recovery) => {
    if (
      !(await ask(
        t(
          "Permanently delete {name}'s saved recovery checkpoint? Recovery from this checkpoint will no longer be possible. Independent backups remain until their retention expires.",
          { name: point.name },
        ),
        t("Delete recovery checkpoint"),
      ))
    )
      return;
    setBusy(point.name);
    setError("");
    try {
      await api.purgeRecovery(point.name);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <section class="mt-6" data-testid="retained-recoveries">
      <div class="section-title !mx-0">{t("Recovery checkpoints")}</div>
      <p class="text-xs text-[var(--t3)] mb-3">
        {t(
          "Removing a cloud kitty keeps its saved computer here. Delete its checkpoint only when you no longer need that recovery copy.",
        )}
      </p>
      {points.length === 0 && !error && (
        <p class="text-sm text-[var(--t3)]">{t("No recovery checkpoints saved.")}</p>
      )}
      {points.map((point) => (
        <div
          class="callout flex flex-col gap-2 mb-2 text-sm"
          key={point.name}
          data-testid="recovery-entry"
        >
          <div class="flex gap-2 items-center flex-wrap">
            <strong>{point.name}</strong>
            <span class="tag">{point.removed ? t("Kitty removed") : t("Computer retained")}</span>
            {point.pending && <span class="text-xs">{t("Recovery operation in progress")}</span>}
          </div>
          <code class="break-all text-xs">{point.checkpoint_name}</code>
          {point.checkpoint_at && !point.checkpoint_at.startsWith("0001") && (
            <span class="text-xs text-[var(--t3)]">
              {t("Saved {when}.", { when: when(point.checkpoint_at) })}
            </span>
          )}
          <button
            class="btn-danger px-2 py-1 text-xs self-start"
            disabled={!!busy || !point.removed || !!point.pending}
            title={
              !point.removed
                ? t("Remove the kitty before deleting its recovery checkpoint.")
                : undefined
            }
            onClick={() => purge(point)}
            data-testid="purge-recovery"
          >
            {t("Delete recovery checkpoint")}
          </button>
        </div>
      ))}
      {error && (
        <p class="text-sm text-[var(--c-red)]" role="alert">
          {error}
        </p>
      )}
      <button class="btn-ghost px-2 py-1 text-xs mt-2" disabled={!!busy} onClick={load}>
        {t("Refresh checkpoints")}
      </button>
    </section>
  );
}
