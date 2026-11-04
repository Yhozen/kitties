import { useLayoutEffect } from "preact/hooks";
import { t } from "./i18n";
import { IconX } from "./icons";

// Modal is the window over the page: a title, a close button, Escape and a click outside close it.
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: preact.ComponentChildren;
  wide?: boolean;
}) {
  useLayoutEffect(() => {
    // A window inside this one that used the key (the live desktop) keeps this one open.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      class="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4 backdrop"
      onClick={onClose}
      data-modal
    >
      <div
        class={`chat-modal w-full ${wide ? "max-w-3xl" : "max-w-md"} p-5 max-h-[90vh] overflow-y-auto scroll-thin`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-mono text-base tracking-wide">{title}</h2>
          <button
            class="plain p-1 text-[var(--t3)] hover:text-[var(--t1)]"
            onClick={onClose}
            aria-label={t("Close")}
          >
            <IconX />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
