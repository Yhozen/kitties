import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";

const aliases: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 9 * * *",
  "@weekly": "0 9 * * 1",
  "@monthly": "0 9 1 * *",
};

function field(text: string, min: number, max: number) {
  if (!text) throw Error("INVALID_SCHEDULE");
  const values = new Set<number>();

  for (const part of text.split(",")) {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);

    if (!match) throw Error("INVALID_SCHEDULE");
    const step = Number(match[2] ?? 1);

    if (step < 1) throw Error("INVALID_SCHEDULE");

    let lo = min,
      hi = max;

    if (match[1] !== "*") {
      const range = match[1]!.split("-").map(Number);
      lo = range[0]!;
      hi = range[1] ?? (step > 1 ? max : lo);
    }

    if (lo < min || hi > max || lo > hi) throw Error("INVALID_SCHEDULE");

    for (let n = lo; n <= hi; n += step) values.add(n);
  }

  return text === "*" ? [] : [...values];
}

export function goalSchedule(expression: string, timezone: string) {
  const parts = (aliases[expression.trim().toLowerCase()] ?? expression.trim()).split(/\s+/);

  if (parts.length !== 5) throw Error("INVALID_SCHEDULE");

  return Cron.make({
    seconds: [0],
    minutes: field(parts[0]!, 0, 59),
    hours: field(parts[1]!, 0, 23),
    days: field(parts[2]!, 1, 31),
    months: field(parts[3]!, 1, 12),
    weekdays: field(parts[4]!, 0, 7),
    tz: DateTime.zoneMakeNamedUnsafe(timezone),
    onDstOverlap: "both",
  });
}

export function nextSlot(expression: string, timezone: string, after: number) {
  const next = Cron.next(goalSchedule(expression, timezone), new Date(after)).getTime();

  if (next - after > 366 * 86400000) throw Error("INVALID_SCHEDULE");

  return next;
}
