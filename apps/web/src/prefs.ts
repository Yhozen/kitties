import { useEffect, useState } from "preact/hooks";

// The person's display preferences, kept in this browser: whether to see technical details
// (coordinates, commands, tokens, errors as the services wrote them).

const TECH = "kitties.tech";
const listeners = new Set<() => void>();

function read(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

let tech = read(TECH) === "1";

// techDetails reports whether the technical details are shown.
export function techDetails(): boolean {
  return tech;
}

// setTechDetails shows or hides them, everywhere at once.
export function setTechDetails(on: boolean): void {
  tech = on;
  try {
    localStorage.setItem(TECH, on ? "1" : "");
  } catch {
    /* kept for this visit only */
  }
  listeners.forEach((l) => l());
}

// useTechDetails is techDetails for a component, which draws again when it changes.
export function useTechDetails(): boolean {
  const [on, setOn] = useState(tech);
  useEffect(() => {
    const l = () => setOn(tech);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
