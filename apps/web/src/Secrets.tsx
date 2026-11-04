import { useEffect, useState } from "preact/hooks";
import type { Kitty, Secret } from "./api";
import { api, errText } from "./api";
import { ask } from "./Confirm";
import { t } from "./i18n";
import { IconTrash } from "./icons";
import { Missing, Required } from "./Required";

// THE SECRETS A KITTY MAY TYPE FOR YOU.
//
// A password or a code is saved here with the kitties that may use it. A kitty is told the names
// it may use and asks for one by name; the secret goes from the vault to its keyboard and the
// kitty, its model and the chat never read it. They are kept encrypted on the gateway, and what
// this list shows is names and kitties, never values.

const LABEL = "block text-xs text-[var(--t3)] mb-1 mt-3 uppercase tracking-wider font-mono";
const INPUT = "w-full px-3 py-2 text-sm";

// KittyChips lets the person pick kitties: one chip each.
function KittyChips({
  kitties,
  on,
  onToggle,
  label,
}: {
  kitties: Kitty[];
  on: string[];
  onToggle: (id: string) => void;
  label: string;
}) {
  return (
    <div class="flex flex-wrap gap-2" role="group" aria-label={label}>
      {kitties.map((k) => (
        <label key={k.id} class={`chip ${on.includes(k.id) ? "on" : ""}`}>
          <input
            type="checkbox"
            class="sr-only"
            checked={on.includes(k.id)}
            onChange={() => onToggle(k.id)}
          />
          {k.name}
        </label>
      ))}
    </div>
  );
}

const toggled = (list: string[], id: string) =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

export default function Secrets({ kitties }: { kitties: Kitty[] }) {
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [who, setWho] = useState<string[]>([]);
  useEffect(() => {
    api
      .vault()
      .then(setSecrets)
      .catch((e) => setErr(errText(e)));
  }, []);
  const act = async (fn: () => Promise<Secret[]>) => {
    setErr("");
    try {
      setSecrets(await fn());
    } catch (e) {
      setErr(errText(e));
    }
  };
  const add = () =>
    act(async () => {
      const list = await api.saveSecret(name, { value, kitties: who });
      setName("");
      setValue("");
      setWho([]);
      return list;
    });
  const label = (id: string) => kitties.find((k) => k.id === id)?.name || id;
  return (
    <div data-testid="secrets">
      <p class="text-sm text-[var(--t2)]">
        {t(
          "Passwords and codes your kitties may type for you. A kitty is told only the names, and asks for one by name: the secret goes from here to its keyboard, and neither the kitty nor its AI model ever reads it. They are kept encrypted on the gateway.",
        )}
      </p>
      {err && (
        <p class="text-sm text-[var(--c-red)] mt-2" role="alert">
          {err}
        </p>
      )}
      {secrets && secrets.length === 0 && (
        <p class="text-sm text-[var(--t4)] mt-3">
          {t(
            "No secrets yet. Save one below, or tick “it is a secret” when a kitty asks for help.",
          )}
        </p>
      )}
      <div class="flex flex-col gap-2 mt-3" data-testid="secret-list">
        {(secrets || []).map((s) => (
          <div key={s.name} class="goal" data-secret={s.name}>
            <div class="flex items-center gap-2">
              <span class="font-semibold flex-1 truncate">🔑 {s.name}</span>
              <button
                class="btn-ghost px-2 py-1 text-xs text-[var(--c-red)]"
                aria-label={t("Remove the secret {name}", { name: s.name })}
                onClick={async () =>
                  (await ask(t("Remove the secret {name}?", { name: s.name }))) &&
                  act(() => api.deleteSecret(s.name))
                }
              >
                <IconTrash size={12} />
              </button>
            </div>
            <div class="text-xs text-[var(--t3)] mt-1 mb-1">
              {s.kitties.length
                ? t("May be used by {names}", { names: s.kitties.map(label).join(", ") })
                : t("No kitty may use it yet")}
            </div>
            <KittyChips
              kitties={kitties}
              on={s.kitties}
              label={t("Kitties that may use {name}", { name: s.name })}
              onToggle={(id) =>
                act(() => api.saveSecret(s.name, { kitties: toggled(s.kitties, id) }))
              }
            />
          </div>
        ))}
      </div>
      <div class="mt-4 p-3 border border-[rgb(var(--accent-rgb)/0.3)] bg-[rgb(var(--accent-rgb)/0.05)]">
        <label class={LABEL} for="secret-name">
          {t("Name")}
          <Required />
        </label>
        <input
          id="secret-name"
          class={INPUT}
          value={name}
          placeholder={t("Shop password")}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <label class={LABEL} for="secret-value">
          {t("The secret")}
          <Required />
        </label>
        <input
          id="secret-value"
          class={INPUT}
          type="password"
          autocomplete="off"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <label class={LABEL}>{t("Kitties that may use it")}</label>
        <KittyChips
          kitties={kitties}
          on={who}
          label={t("Kitties that may use it")}
          onToggle={(id) => setWho(toggled(who, id))}
        />
        <div class="flex justify-end mt-3">
          <button
            class="btn-accent px-3 py-1.5 text-xs"
            disabled={!name.trim() || !value}
            onClick={add}
            data-testid="secret-save"
          >
            {t("Save the secret")}
          </button>
        </div>
        <Missing items={[!name.trim() && t("the name"), !value && t("the secret")]} />
      </div>
    </div>
  );
}
