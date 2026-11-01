import es from "./i18n/es";
import pt from "./i18n/pt";

// THE PAGE'S LANGUAGE.
//
// Every text of the page is written in English inside t(); a dictionary per language gives its
// translation, keyed by the English text, and a text without one stays in English. The language
// is the person's choice (Settings, Preferences), or the system's, kept in this browser; ?lang=
// in the address picks one for a visit.

export type Lang = "en" | "es" | "pt";

export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
  { id: "pt", label: "Português" },
];

const KEY = "kitties.lang";
const dictionaries: Record<Lang, Record<string, string>> = { en: {}, es, pt };

function saved(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

// detect is the language asked for in the address, chosen before, or the system's.
function detect(): Lang {
  const asked = new URLSearchParams(location.search).get("lang") || saved();
  if (LANGS.some((l) => l.id === asked)) {
    return asked as Lang;
  }
  // The first of the system's languages the page speaks.
  const system = (navigator.languages?.length ? navigator.languages : [navigator.language]) || [];
  for (const l of system) {
    const code = l?.toLowerCase().slice(0, 2);
    if (LANGS.some((x) => x.id === code)) {
      return code as Lang;
    }
  }
  return "en";
}

let lang: Lang = typeof location === "undefined" ? "en" : detect();
if (typeof document !== "undefined") {
  document.documentElement.lang = lang;
}

// currentLang is the language the page speaks.
export function currentLang(): Lang {
  return lang;
}

// setLang keeps the person's choice and draws the page again in it.
export function setLang(next: Lang): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* kept for this visit only */
  }
  lang = next;
  location.reload();
}

// t is a text of the page in its language; {name} in it takes vars.name.
export function t(text: string, vars?: Record<string, string | number>): string {
  let out = dictionaries[lang][text] ?? text;
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }
  return out;
}

// Dictionary is one file's translations, keyed by the English text.
export type Dictionary = Record<string, string>;
