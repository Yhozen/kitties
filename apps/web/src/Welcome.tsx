import type { Kitty, ProviderInfo, Session } from "./api";
import PixelCat from "./PixelCat";
import { t } from "./i18n";

// Welcome is what the main area shows with no chat open. Until the basics are in place it is a
// short checklist, each step with the one button that does it; after that, a few shortcuts.
export default function Welcome({
  models,
  kitties,
  chats,
  onAddModel,
  onNewKitty,
  onNewChat,
  onConnections,
  onNotifications,
}: {
  models: ProviderInfo[];
  kitties: Kitty[];
  chats: Session[];
  onAddModel: () => void;
  onNewKitty: () => void;
  onNewChat: () => void;
  onConnections: () => void;
  onNotifications: () => void;
}) {
  const steps = [
    {
      done: models.length > 0,
      title: t("Give your kitties a brain"),
      text: t(
        "Add a model from a provider you have an account with (Claude, OpenAI, Gemini…), or Ollama to run free models on this computer.",
      ),
      action: t("Add a model"),
      onClick: onAddModel,
      ready: true,
    },
    {
      done: kitties.length > 0,
      title: t("Create your first kitty"),
      text: t("Give it a name, a personality and a look. It starts working at once."),
      action: t("Create a kitty"),
      onClick: onNewKitty,
      ready: models.length > 0,
    },
    {
      done: chats.length > 0,
      title: t("Start a chat"),
      text: t("Ask it anything, or give it a task. Several kitties in one chat work as a team."),
      action: t("Start a chat"),
      onClick: onNewChat,
      ready: kitties.length > 0,
    },
  ];
  const left = steps.filter((s) => !s.done).length;
  return (
    <main class="flex-1 flex items-center justify-center p-6 overflow-y-auto">
      <div class="empty-card max-w-lg w-full p-6" data-testid="welcome">
        <div class="flex items-center gap-3 mb-2">
          <PixelCat breed="tabby" color="orange" mood={left ? "idle" : "happy"} size={44} />
          <div>
            <h2 class="font-mono text-lg">{left ? t("Welcome to Kitties") : t("No chat open")}</h2>
            <p class="text-sm text-[var(--t3)]">
              {left
                ? left === 1
                  ? t("One step to get your kitties working.")
                  : t("{count} steps to get your kitties working.", { count: left })
                : t(
                    "Pick a chat on the left, or start a new one. In a group, write @name to pick who answers.",
                  )}
            </p>
          </div>
        </div>
        {left > 0 && (
          <ol class="checklist mt-3">
            {steps.map((s, i) => (
              <li key={s.title} class={s.done ? "done" : ""}>
                <span class="mark">{s.done ? "✓" : i + 1}</span>
                <div class="flex-1 min-w-0">
                  <div class={`text-sm font-semibold ${s.done ? "text-[var(--t3)]" : ""}`}>
                    {s.title}
                  </div>
                  {!s.done && <p class="text-xs text-[var(--t3)] mt-0.5">{s.text}</p>}
                </div>
                {!s.done && (
                  <button
                    class={`${s.ready ? "btn-accent" : "btn-ghost"} px-3 py-1.5 text-xs flex-none`}
                    disabled={!s.ready}
                    onClick={s.onClick}
                  >
                    {s.action}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        <div class="flex flex-wrap gap-2 mt-4">
          {left === 0 && (
            <button class="btn-accent px-3 py-1.5 text-xs" onClick={onNewChat}>
              {t("New chat")}
            </button>
          )}
          <button class="btn-ghost px-3 py-1.5 text-xs" onClick={onConnections}>
            {t("Connect a service")}
          </button>
          <button class="btn-ghost px-3 py-1.5 text-xs" onClick={onNotifications}>
            {t("Get alerts on your phone")}
          </button>
        </div>
      </div>
    </main>
  );
}
