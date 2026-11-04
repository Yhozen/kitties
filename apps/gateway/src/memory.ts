export interface Note {
  id: string;
  scope: string;
  text: string;
  strength: number;
  at: number;
  updated: number;
  source: string;
  pinned: boolean;
}

export interface Memory {
  notes: Note[];
  profile: {
    demand: number;
    auto: boolean;
    up: number;
    down: number;
    recent: string[];
    pending: number;
  };
  feedback: { id: string; rating: "up" | "down"; note: string; at: number }[];
}

export type MemoryCommand =
  | {
      type: "remember";
      id: string;
      scope: string;
      text: string;
      source: string;
      pinned: boolean;
      at: number;
    }
  | { type: "forget"; id: string }
  | { type: "profile"; demand: number; auto: boolean }
  | { type: "feedback"; id: string; rating: "up" | "down"; note: string; at: number }
  | {
      type: "distill";
      notes: { scope: string; text: string; strength: number }[];
      pending: number;
      at: number;
    };

export const freshMemory = (): Memory => ({
  notes: [],
  profile: { demand: 3, auto: true, up: 0, down: 0, recent: [], pending: 0 },
  feedback: [],
});

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

export const validScope = (scope: string) =>
  scope === "user" || scope === "work" || /^project:[a-z0-9][a-z0-9 _-]{0,39}$/.test(scope);

export function updateMemory(previous: Memory, command: MemoryCommand): Memory {
  const memory = structuredClone(previous),
    profile = memory.profile;

  switch (command.type) {
    case "remember": {
      if (!validScope(command.scope) || !command.text.trim() || command.text.length > 240)
        throw Error("INVALID_MEMORY");

      const duplicate = memory.notes.find(
        (note) => note.scope === command.scope && normalize(note.text) === normalize(command.text),
      );

      if (duplicate) {
        duplicate.strength++;
        duplicate.updated = command.at;
        duplicate.pinned ||= command.pinned;
        break;
      }

      memory.notes.push({
        id: command.id,
        scope: command.scope,
        text: command.text.trim(),
        strength: 1,
        at: command.at,
        updated: command.at,
        source: command.source,
        pinned: command.pinned,
      });

      while (memory.notes.length > 60) {
        const index = memory.notes.findIndex((note) => !note.pinned);

        if (index < 0) throw Error("MEMORY_LIMIT");
        memory.notes.splice(index, 1);
      }

      break;
    }

    case "forget":
      memory.notes = memory.notes.filter((note) => note.id !== command.id);
      break;
    case "profile":
      if (command.demand < 1 || command.demand > 5 || !Number.isInteger(command.demand))
        throw Error("INVALID_DEMAND");
      profile.demand = command.demand;
      profile.auto = command.auto;
      profile.recent = [];
      break;
    case "feedback": {
      const duplicate = memory.feedback.find((item) => item.id === command.id);

      if (duplicate) {
        if (duplicate.rating !== command.rating || duplicate.note !== command.note)
          throw Error("FEEDBACK_CONFLICT");
        break;
      }

      memory.feedback.push({ ...command, note: command.note.slice(0, 300) });
      memory.feedback = memory.feedback.slice(-60);
      profile[command.rating]++;
      profile.pending++;
      profile.recent.push(command.rating === "up" ? "u" : "d");
      profile.recent = profile.recent.slice(-10);

      if (profile.auto) {
        const downs = profile.recent.filter((rating) => rating === "d").length;

        if (downs >= 4 && profile.demand < 5) {
          profile.demand++;
          profile.recent = [];
        } else if (profile.recent.length === 10 && downs === 0 && profile.demand > 1) {
          profile.demand--;
          profile.recent = [];
        }
      }

      break;
    }

    case "distill": {
      memory.notes = memory.notes.filter((note) => note.pinned);

      for (const [index, note] of command.notes.entries()) {
        if (
          !validScope(note.scope) ||
          !note.text.trim() ||
          note.text.length > 240 ||
          memory.notes.length >= 60
        )
          continue;

        if (
          memory.notes.some(
            (old) => old.scope === note.scope && normalize(old.text) === normalize(note.text),
          )
        )
          continue;
        memory.notes.push({
          ...note,
          id: `distilled-${command.at}-${index}`,
          strength: Math.max(1, Math.min(100, note.strength)),
          at: command.at,
          updated: command.at,
          source: "distilled",
          pinned: false,
        });
      }

      profile.pending = Math.max(0, profile.pending - command.pending);
      break;
    }
  }

  return memory;
}

export const memoryPrompt = (memory: Memory) =>
  `Owner demand: ${memory.profile.demand}/5 (1=relaxed; 5=verify carefully and show evidence).\nRemembered context:\n${[
    ...memory.notes,
  ]
    .sort((a, b) => b.strength - a.strength || b.updated - a.updated)
    .slice(0, 30)
    .map((note) => `[${note.scope}] ${note.text}`)
    .join("\n")}`;
