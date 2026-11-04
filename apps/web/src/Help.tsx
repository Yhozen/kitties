import { useEffect, useState } from "preact/hooks";
import type { Kitty, Step } from "./api";
import { api, errText, shotData } from "./api";
import { t } from "./i18n";
import { IconHand } from "./icons";
import { Modal } from "./Modal";

// A KITTY THAT NEEDS YOU.
//
// When a kitty asks for help on its computer, this window opens over the chat with what it sees
// and a box for what it needs: a code, a password, an answer. The person can tell it, have it
// typed on the kitty's desktop without the kitty being shown it (a secret), take the desktop
// over, or leave it for later.

export default function HelpModal({
  kitty,
  chat,
  turn,
  step,
  onTakeControl,
  onClose,
}: {
  kitty: Kitty;
  chat: string;
  turn: number;
  step: Step;
  onTakeControl: () => void;
  onClose: () => void;
}) {
  const [shot, setShot] = useState("");
  const [text, setText] = useState("");
  const [secret, setSecret] = useState(false);
  const [enter, setEnter] = useState(false);
  // save keeps the secret in the vault under a name, for this kitty, to type it again unasked.
  const [save, setSave] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!step.shot) {
      return;
    }
    let alive = true;
    shotData(`/v1/chats/${chat}/shots/${step.shot}`)
      .then((s) => alive && setShot(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [chat, step.shot]);
  const send = async () => {
    if (!text.trim() || busy) {
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.answerHelp(chat, turn, {
        text,
        secret,
        enter: secret && enter,
        save: secret ? save.trim() : "",
      });
      onClose();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const reason = String(step.args?.reason ?? step.result ?? "");
  return (
    <Modal title={t("{name} needs your help", { name: kitty.name })} onClose={onClose} wide>
      <div data-testid="help-modal">
        <p class="flex items-start gap-2 text-sm mb-3">
          <span class="mt-0.5 text-[var(--c-amber)]">
            <IconHand size={16} />
          </span>
          <span>{reason}</span>
        </p>
        {shot ? (
          <img class="live-shot" src={shot} alt={t("What {name} sees", { name: kitty.name })} />
        ) : (
          <div class="live-shot" />
        )}
        <label
          class="block text-xs text-[var(--t3)] mb-1 mt-4 uppercase tracking-wider font-mono"
          for="help-text"
        >
          {t("What {name} needs", { name: kitty.name })}
        </label>
        <input
          id="help-text"
          class="w-full px-3 py-2 text-sm"
          type={(secret ? "password" : "text") as "text"}
          autocomplete="off"
          value={text}
          placeholder={t("A code, a password, an answer…")}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          data-testid="help-input"
        />
        <label class="flex items-center gap-2 text-xs text-[var(--t3)] mt-2">
          <input
            type="checkbox"
            checked={secret}
            onChange={(e) => setSecret((e.target as HTMLInputElement).checked)}
            data-testid="help-secret"
          />
          {t("It is a secret: type it on its desktop, and do not show it to {name}", {
            name: kitty.name,
          })}
        </label>
        {secret && (
          <>
            <label class="flex items-center gap-2 text-xs text-[var(--t3)] mt-1">
              <input
                type="checkbox"
                checked={enter}
                onChange={(e) => setEnter((e.target as HTMLInputElement).checked)}
              />
              {t("Press Enter after")}
            </label>
            <label class="block text-xs text-[var(--t3)] mt-2" for="help-save">
              {t("Keep it for {name} under the name (optional)", { name: kitty.name })}
            </label>
            <input
              id="help-save"
              class="w-full px-3 py-2 text-sm mt-1"
              value={save}
              placeholder={t("Shop password")}
              onInput={(e) => setSave((e.target as HTMLInputElement).value)}
              data-testid="help-save"
            />
          </>
        )}
        {err && <p class="text-sm text-[var(--c-red)] mt-2">{err}</p>}
        <div class="flex flex-wrap items-center gap-2 mt-4">
          <button
            class="btn-accent px-3 py-2 text-sm"
            disabled={!text.trim() || busy}
            onClick={send}
            data-testid="help-send"
          >
            {secret ? t("Type it on the desktop") : t("Tell {name}", { name: kitty.name })}
          </button>
          <button
            class="btn-outline px-3 py-2 text-sm"
            onClick={onTakeControl}
            data-testid="help-modal-control"
          >
            {t("Take control")}
          </button>
          <span class="flex-1" />
          <button class="btn-ghost px-3 py-2 text-sm" onClick={onClose}>
            {t("Not now")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
