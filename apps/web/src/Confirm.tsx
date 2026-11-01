import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { t } from "./i18n";

// The page asks before it removes something with a dialog of its own: window.confirm is not
// shown by every webview (the desktop app's on macOS answers "no" without asking), which left
// nothing removable there.

type Question = { text: string; yes: string; answer: (ok: boolean) => void };

let show: ((q: Question | null) => void) | null = null;

// ask shows the question and resolves with the person's answer; yes names the action.
export function ask(text: string, yes = t("Remove")): Promise<boolean> {
  return new Promise((answer) => {
    if (!show) {
      answer(false);
      return;
    }
    show({ text, yes, answer });
  });
}

// ConfirmHost draws the question asked; the app mounts it once.
export function ConfirmHost() {
  const [q, setQ] = useState<Question | null>(null);
  useEffect(() => {
    show = setQ;
    return () => {
      show = null;
    };
  }, []);
  const reply = (ok: boolean) => {
    q?.answer(ok);
    setQ(null);
  };
  useLayoutEffect(() => {
    if (!q) {
      return;
    }
    // Escape says no to this question only, not to the dialog behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        reply(false);
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [q]);
  if (!q) {
    return null;
  }
  return (
    <div
      class="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4 backdrop"
      onClick={() => reply(false)}
    >
      <div
        class="chat-modal w-full max-w-sm p-5"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-text"
        onClick={(e) => e.stopPropagation()}
        data-testid="confirm"
      >
        <p id="confirm-text" class="text-sm">
          {q.text}
        </p>
        <div class="flex justify-end gap-2 mt-4">
          <button class="btn-ghost px-4 py-2 text-sm" onClick={() => reply(false)} autofocus>
            {t("Cancel")}
          </button>
          <button class="btn-danger px-4 py-2 text-sm" onClick={() => reply(true)}>
            {q.yes}
          </button>
        </div>
      </div>
    </div>
  );
}
