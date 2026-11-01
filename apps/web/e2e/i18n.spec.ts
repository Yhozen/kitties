import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// load merges the dictionaries of a language, as the page does.
async function load(lang: string): Promise<Record<string, string>> {
  const dir = path.join(src, "i18n", lang);
  const out: Record<string, string> = {};
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".ts") && file !== "index.ts") {
      Object.assign(out, ((await import(path.join(dir, file))) as { default: object }).default);
    }
  }
  return out;
}

// Every text the page wraps in t("…") has its translation in every language: a missing one
// would show in English in the middle of the page.
test("every text of the page has its Spanish and its Portuguese", async () => {
  const es = await load("es");
  const pt = await load("pt");
  const missing: string[] = [];
  const literal = /\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  for (const file of fs.readdirSync(src)) {
    if (!/\.tsx?$/.test(file) || file === "i18n.ts") {
      continue;
    }
    const text = fs.readFileSync(path.join(src, file), "utf8");
    for (const m of text.matchAll(literal)) {
      const key = m[1].startsWith('"')
        ? (JSON.parse(m[1]) as string)
        : m[1].slice(1, -1).replace(/\\'/g, "'");
      for (const [lang, dict] of [
        ["es", es],
        ["pt", pt],
      ] as const) {
        if (!(key in dict)) {
          missing.push(`${lang} ${file}: ${key}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
  // Both languages translate the same texts, each keeping the {placeholders} of its key.
  expect(Object.keys(pt).sort()).toEqual(Object.keys(es).sort());
  const holes = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join();
  const wrong = Object.keys(es).filter(
    (k) => holes(es[k]) !== holes(k) || holes(pt[k]) !== holes(k),
  );
  expect(wrong).toEqual([]);
});
