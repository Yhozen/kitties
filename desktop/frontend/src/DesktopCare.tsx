import { useEffect, useState } from "preact/hooks";
import type { DesktopInfo, Kitty } from "./api";
import { api, errText } from "./api";
import { ask } from "./Confirm";
import { when } from "./format";
import { t } from "./i18n";

export default function DesktopCare({
  kitty,
  runtime = "container",
  onChanged,
  onSleep,
}: {
  kitty: Kitty;
  runtime?: string;
  onChanged: () => void;
  onSleep?: () => Promise<unknown>;
}) {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () =>
    api
      .desktopInfo(kitty.id)
      .then(setInfo)
      .catch(() => setInfo(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitty.id, kitty.status]);
  if (!info) return null;
  const kind = kitty.computer?.runtime || info.capabilities?.kind || runtime;
  const persistent = info.capabilities?.persistent_disk ?? (kind === "lima" || kind === "boat");
  const imageUpdates = info.capabilities?.image_updates ?? !persistent;
  const changing = kitty.status === "starting" || kitty.status === "stopping";
  const checkpoint = kitty.computer?.checkpoint_id;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const update = async () => {
    if (
      await ask(
        t(
          "Update {name}'s desktop? It restarts. Its cookies, sessions and saved passwords are backed up first and put back in the new one.",
          { name: kitty.name },
        ),
        t("Update"),
      )
    )
      void act(() => api.updateKitty(kitty.id));
  };
  return (
    <div class="mt-3 flex flex-col gap-2 text-sm" data-testid="desktop-care">
      {persistent && (
        <>
          <p class="text-xs text-[var(--t3)]">
            {kind === "boat"
              ? t(
                  "Sleep saves this computer and lets tasks wake it. Stop keeps it off until you choose Start. Apps may restart when it wakes.",
                )
              : t(
                  "Files and installed apps stay on this VM's disk when it stops. The backups below cover browser sessions, not the whole computer.",
                )}
          </p>
          {onSleep && (
            <button
              class="btn-ghost px-2 py-1 text-xs self-start"
              disabled={busy || changing || kitty.status !== "running"}
              onClick={() => act(onSleep)}
              data-testid="sleep-computer"
            >
              {t("Sleep")}
            </button>
          )}
        </>
      )}
      {kind === "boat" && (
        <div class="callout text-xs flex flex-col gap-2" data-testid="recovery-state">
          <span>
            {checkpoint
              ? t("A saved recovery checkpoint is available.")
              : t("No saved recovery checkpoint yet. A successful sleep or stop creates one.")}
          </span>
          {checkpoint && <code class="break-all">{checkpoint}</code>}
          <span class="text-[var(--t3)]">
            {t(
              "Removing this kitty keeps its recovery checkpoint. Independent backups follow the configured retention.",
            )}
          </span>
          <p class="text-[var(--t3)]">
            {t("Manage retained recovery checkpoints in Settings → Preferences.")}
          </p>
        </div>
      )}
      {imageUpdates && info.update_available && (
        <div class="callout flex items-center gap-2" data-testid="update-callout">
          <span class="flex-1">
            {t("A newer desktop is available for {name}.", { name: kitty.name })}
          </span>
          <button
            class="btn-accent px-3 py-1.5 text-sm"
            disabled={busy || changing}
            onClick={update}
            data-testid="update-desktop"
          >
            {t("Update the desktop")}
          </button>
        </div>
      )}
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-[var(--t3)] flex-1" data-testid="backup-state">
          {info.backup
            ? t("Cookies, sessions and passwords backed up {when}.", {
                when: when(info.backup.saved),
              })
            : t("Cookies, sessions and passwords are not backed up yet.")}
        </span>
        <button
          class="btn-ghost px-2 py-1 text-xs"
          disabled={busy || kitty.status !== "running"}
          onClick={() => act(() => api.backupKitty(kitty.id))}
          data-testid="backup-now"
        >
          {t("Back up now")}
        </button>
      </div>
      {imageUpdates && info.auto_update && (
        <p class="text-xs text-[var(--t3)]" data-testid="auto-update">
          {t(
            "Newer desktops are downloaded and installed by themselves when {name} is idle; its cookies, sessions and passwords come along.",
            { name: kitty.name },
          )}
        </p>
      )}
      {imageUpdates && (
        <p class="text-xs text-[var(--t4)]">
          {t(
            "The backup is sealed and kept away from the desktop, and goes back into it when it is made anew. It is also made when the desktop stops.",
          )}
        </p>
      )}
      {err && (
        <p class="text-sm text-[var(--c-red)]" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
