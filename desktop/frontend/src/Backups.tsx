import { useEffect, useState } from "preact/hooks";
import { api, ApiError, errText, type BackupStatus } from "./api";
import { when } from "./format";
import { t } from "./i18n";

export default function Backups() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const load = async () => {
    try {
      setStatus(await api.backupStatus());
      setError("");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) setStatus(null);
      else setError(errText(e));
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(load, status?.running ? 2000 : 15000);
    return () => clearInterval(timer);
  }, [status?.running]);
  if (!status?.enabled && !error) return null;
  const run = async () => {
    setStarting(true);
    setError("");
    try {
      setStatus(await api.backupNow());
    } catch (e) {
      setError(errText(e));
    } finally {
      setStarting(false);
    }
  };
  const saved =
    status?.last_success && !status.last_success.startsWith("0001") ? status.last_success : "";
  return (
    <section class="mt-6" data-testid="independent-backups">
      <div class="section-title !mx-0">{t("Encrypted backups")}</div>
      <p class="text-xs text-[var(--t3)] mb-3">
        {t(
          "Recovery copies are saved separately from the live gateway and cloud computers. Seven daily and four weekly copies are kept.",
        )}
      </p>
      <div class="callout text-sm flex flex-col gap-2">
        {status?.running ? (
          <p role="status">
            {status.phase === "capturing"
              ? t("Backup in progress. New tasks will resume when the recovery copy is captured.")
              : t("Backup in progress.")}
          </p>
        ) : status?.overdue ? (
          <p class="text-[var(--c-red)]">
            {t("A backup is overdue. Back up now or check the last error.")}
          </p>
        ) : null}
        <p>
          {saved
            ? t("Last successful backup: {when}.", { when: when(saved) })
            : t("No successful backup yet.")}
        </p>
        {status?.snapshot_id && <code class="text-xs break-all">{status.snapshot_id}</code>}
        {(error || status?.last_error) && (
          <p role="alert" class="text-[var(--c-red)]">
            {error || status?.last_error}
          </p>
        )}
        <button
          class="btn-ghost px-2 py-1 text-xs self-start"
          disabled={!status?.enabled || status.running || starting}
          onClick={run}
          data-testid="backup-now"
        >
          {starting ? t("Starting backup…") : t("Back up now")}
        </button>
      </div>
    </section>
  );
}
