import { useEffect, useState } from "preact/hooks";
import type { UpdateStatus } from "./api";
import { api, errText } from "./api";
import { ask } from "./Confirm";
import { when } from "./format";
import { t } from "./i18n";

// THE VERSION OF KITTIES.
//
// Which version runs, whether a newer one is out, and the way to move to it: a gateway that may
// replace itself does it from here (and restarts: the desktops of the kitties keep running); one
// that may not (in a container, inside the app, a development build) says how it is updated.
// Whether it looks by itself, and installs by itself, is `updates:` in the configuration.

export default function Updates() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [restarting, setRestarting] = useState("");
  useEffect(() => {
    api
      .updateStatus()
      .then(setSt)
      // A gateway that does not look for new versions (an older one) shows nothing.
      .catch(() => setSt(null));
  }, []);
  if (!st) {
    return null;
  }
  const check = async () => {
    setBusy(true);
    setErr("");
    try {
      setSt(await api.updateStatus(true));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  // The gateway restarts a moment after it answers: the page waits for the new version to answer
  // and loads it.
  const follow = (from: string) => {
    let tries = 0;
    const id = setInterval(async () => {
      tries++;
      try {
        const h = await api.health();
        if (h.version && h.version !== from) {
          clearInterval(id);
          location.reload();
        }
      } catch {
        /* it is restarting */
      }
      if (tries > 60) {
        clearInterval(id);
        setRestarting("");
        setErr(t("Kitties did not come back in a minute: restart it by hand."));
      }
    }, 1000);
  };
  const apply = async () => {
    const yes = await ask(
      t(
        "Update Kitties to {version}? It restarts in a moment; the kitties' desktops keep running.",
        { version: st.latest || "" },
      ),
      t("Update"),
    );
    if (!yes) {
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await api.applyUpdate();
      setRestarting(r.updated_to);
      follow(st.current);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="mt-6 pt-4 border-t border-white/5" data-testid="updates">
      <div class="section-title !mx-0">{t("Updates")}</div>
      <p class="text-sm">
        {t("Kitties {version}", { version: st.current })}
        {st.latest && !st.available && (
          <span class="text-[var(--t3)]"> · {t("it is the newest version")}</span>
        )}
      </p>
      {st.available && (
        <div class="callout mt-2 flex items-center gap-2 flex-wrap" data-testid="update-available">
          <span class="flex-1">
            {t("Kitties {version} is available.", { version: st.latest || "" })}
            {!st.can_apply && st.why && (
              <span class="block text-xs text-[var(--t3)] mt-1">{st.why}</span>
            )}
          </span>
          {st.can_apply && (
            <button
              class="btn-accent px-3 py-1.5 text-sm"
              disabled={busy || !!restarting}
              onClick={apply}
              data-testid="update-apply"
            >
              {t("Update and restart")}
            </button>
          )}
        </div>
      )}
      {st.available && st.can_apply && !st.signed && (
        <p class="text-xs text-[var(--c-amber)] mt-1" data-testid="update-unsigned">
          {t(
            "This update is checked against its checksums only, which do not say who made it: set updates.public_key to require the release key's signature.",
          )}
        </p>
      )}
      {st.skipped && (
        <p class="text-xs text-[var(--t3)] mt-2" data-testid="update-skipped">
          {t(
            "{version} did not hold here and Kitties went back to {current}: it is not offered again.",
            {
              version: st.skipped,
              current: st.current,
            },
          )}
        </p>
      )}
      {restarting && (
        <p class="text-sm mt-2" role="status" data-testid="update-restarting">
          <span class="spinner" /> {t("Updated to {version}: restarting…", { version: restarting })}
        </p>
      )}
      <div class="flex items-center gap-2 mt-2 flex-wrap">
        <button
          class="btn-ghost px-2 py-1 text-xs"
          disabled={busy || !!restarting || st.mode === "off"}
          onClick={check}
          data-testid="update-check"
        >
          {t("Look for a new version")}
        </button>
        {st.checked_at && (
          <span class="text-xs text-[var(--t4)]">
            {t("Looked {when}.", { when: when(st.checked_at) })}
          </span>
        )}
      </div>
      <p class="text-xs text-[var(--t4)] mt-2">
        {st.mode === "off"
          ? t(
              "Kitties does not look for new versions: turn it on with updates.gateway in the configuration.",
            )
          : st.mode === "auto"
            ? t(
                "Kitties looks for new versions and installs them by itself when nothing is in use.",
              )
            : t("Kitties looks for new versions and tells you; you decide when to update.")}
      </p>
      {(st.error || err) && (
        <p class="text-sm text-[var(--c-red)] mt-2" role="alert">
          {err || st.error}
        </p>
      )}
    </div>
  );
}
