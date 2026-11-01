import { t } from "./i18n";

// What the gateway itself writes into a chat (an approval's outcome, a kitty that could not
// answer, a task handed over) is English, since the kitties read it too. The page says it in its
// own language, line by line; a line it does not recognise, the kitty's own words included,
// stays as it is.

const LINES: [RegExp, string, string[]][] = [
  [/^\((.+?) could not answer: (.+)\)$/, "({name} could not answer: {why})", ["name", "why"]],
  [/^\((.+?) could not finish: (.+)\)$/, "({name} could not finish: {why})", ["name", "why"]],
  [/^\((.+?) needs help: (.+)\)$/, "({name} needs help: {why})", ["name", "why"]],
  [
    /^\(attempt (\d+) failed: (.+); trying another way\)$/,
    "(attempt {n} failed: {why}; trying another way)",
    ["n", "why"],
  ],
  [/^\((.+?) finished without a word\)$/, "({name} finished without a word)", ["name"]],
  [/^\((.+?) had nothing to add\)$/, "({name} had nothing to add)", ["name"]],
  [/^Approved and done: (.*)$/, "Approved and done: {what}", ["what"]],
  [/^Approved, but it failed: (.*)$/, "Approved, but it failed: {what}", ["what"]],
  [/^Rejected: (.*)$/, "Rejected: {what}", ["what"]],
  [/^Reason: (.*)$/, "Reason: {why}", ["why"]],
  [/^Handed over to (.+), who answered:$/, "Handed over to {name}, who answered:", ["name"]],
];

// gatewayText is a chat text with the gateway's own lines in the page's language. The reasons
// in them are the gateway's plain sentences, which have their translation too.
export function gatewayText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const exact = t(line);
      if (exact !== line) {
        return exact;
      }
      for (const [re, key, names] of LINES) {
        const m = line.match(re);
        if (m) {
          const vars: Record<string, string> = {};
          names.forEach((n, i) => (vars[n] = n === "why" ? t(m[i + 1]) : m[i + 1]));
          return t(key, vars);
        }
      }
      return line;
    })
    .join("\n");
}
