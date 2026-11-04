// The logo of a connector kind: a brand mark from simple-icons where one exists, a hand-drawn
// mark otherwise, so the catalogue reads as a row of buttons rather than a list of names.
import {
  siAirtable,
  siApple,
  siHomeassistant,
  siRss,
  siSpotify,
  siThings,
  siTidal,
  siClaude,
  siDeepseek,
  siGithubcopilot,
  siGooglegemini,
  siMistralai,
  siOllama,
  siOpenrouter,
  siQwen,
  siBluesky,
  siDiscord,
  siDropbox,
  siExcalidraw,
  siFacebook,
  siFigma,
  siGitea,
  siGithub,
  siGitlab,
  siGmail,
  siGoogle,
  siGooglechat,
  siGooglesheets,
  siInstagram,
  siJira,
  siLinear,
  siMastodon,
  siMatrix,
  siMermaid,
  siNextcloud,
  siNotion,
  siNtfy,
  siStripe,
  siTelegram,
  siTodoist,
  siTrello,
  siWhatsapp,
  siX,
  siZendesk,
  type SimpleIcon,
} from "simple-icons";

interface Mark {
  path: string;
  hex: string;
  viewBox?: string;
}

const brand = (i: SimpleIcon): Mark => ({ path: i.path, hex: i.hex });

// Marks drawn by hand, for the brands simple-icons does not carry and the kinds that are ours.
const SLACK: Mark = {
  hex: "4A154B",
  path: "M6 15a2 2 0 1 1-2-2h2zm1 0a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0zm2-9a2 2 0 1 1 2-2v2zm0 1a2 2 0 0 1 0 4H4a2 2 0 0 1 0-4zm9 2a2 2 0 1 1 2 2h-2zm-1 0a2 2 0 0 1-4 0V4a2 2 0 0 1 4 0zm-2 9a2 2 0 1 1-2 2v-2zm0-1a2 2 0 0 1 0-4h5a2 2 0 0 1 0 4z",
};
const MICROSOFT: Mark = {
  hex: "5E5E5E",
  path: "M2 2h9.5v9.5H2zm10.5 0H22v9.5h-9.5zM2 12.5h9.5V22H2zm10.5 0H22V22h-9.5z",
};
const TEAMS: Mark = {
  hex: "6264A7",
  path: "M14 4.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0zM9 6a3 3 0 1 1 6 0 3 3 0 0 1-6 0zm-7 5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v6.5A4.5 4.5 0 0 1 10.5 22h-3A4.5 4.5 0 0 1 3 17.5zm14-1h5a1 1 0 0 1 1 1v5.5a3.5 3.5 0 0 1-3.5 3.5h-.2a6 6 0 0 0 .7-3V11a2 2 0 0 0-.3-1zM5 13v2h2.5v5h2v-5H12v-2z",
};
const LINKEDIN: Mark = {
  hex: "0A66C2",
  path: "M4.98 3.5A2.5 2.5 0 1 1 5 8.5a2.5 2.5 0 0 1-.02-5zM3 9h4v12H3zm6 0h3.8v1.7h.1c.5-1 1.8-2 3.8-2 4 0 4.8 2.6 4.8 6V21h-4v-5.5c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9V21H9z",
};
const EMAIL: Mark = {
  hex: "EA4335",
  path: "M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm2 0v.5l8 5.3 8-5.3V5zm16 3.2-8 5.3-8-5.3V19h16z",
};
const WEBHOOK: Mark = {
  hex: "C73A63",
  path: "M10 4a4 4 0 0 1 3.5 6l-2.3 4 1.7 1-2.9 5H5a4 4 0 0 1 0-8h1l1 2H5a2 2 0 0 0 0 4h4l1.8-3-1.7-1 3.7-6.4A2 2 0 1 0 9 6l-1-1.7A4 4 0 0 1 10 4zm9 9a4 4 0 1 1-3.9 5h2.2a2 2 0 1 0 0-2h-3.6l-3.3-5.8 1.7-1 2.8 4.8H19z",
};
const HTTP: Mark = {
  hex: "0F766E",
  path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3a15 15 0 0 0-1.1-5.1A8 8 0 0 1 18.9 11zM12 4a13 13 0 0 1 1.9 7h-3.8A13 13 0 0 1 12 4zM5.1 11a8 8 0 0 1 4.1-5.1A15 15 0 0 0 8.1 11zm0 2h3a15 15 0 0 0 1.1 5.1A8 8 0 0 1 5.1 13zM12 20a13 13 0 0 1-1.9-7h3.8A13 13 0 0 1 12 20zm2.8-1.9a15 15 0 0 0 1.1-5.1h3a8 8 0 0 1-4.1 5.1z",
};
// A calendar page, a contact card and a sun, for the open standards that have no brand.
const CALENDAR: Mark = {
  hex: "4C8DFF",
  path: "M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zM5 9v10h14V9zm2 2h4v4H7z",
};
const CONTACTS: Mark = {
  hex: "F5A524",
  path: "M5 2h13a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5V2zm7 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-5 11h10c0-2.2-2.2-4-5-4s-5 1.8-5 4zM2 6h2v2H2zm0 5h2v2H2zm0 5h2v2H2z",
};
const WEATHER: Mark = {
  hex: "FFB020",
  path: "M11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1zM12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12z",
};
// OmniFocus has no mark in simple-icons: a check in a circle, in its purple.
const OMNIFOCUS: Mark = {
  hex: "8E44AD",
  path: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm4.3 4.3L10.5 14l-2.8-2.8-1.4 1.4 4.2 4.2 7.2-7.1z",
};
const SHELL: Mark = {
  hex: "4EAA25",
  path: "M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h16V6zm2.5 2.6 1.4-1.4L11.3 11l-3.4 3.4-1.4-1.4 2-2zM12 14h6v2h-6z",
};
const MOTITA: Mark = {
  hex: "4CC2FF",
  path: "M4 20V8l4 4 4-5 4 5 4-4v12zm3-3h10v-2H7zm2.5-4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm5 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
};
const KROKI: Mark = { hex: "6965DB", path: siMermaid.path };
const GOOGLE_WORKSPACE: Mark = { hex: "4285F4", path: siGoogle.path };
const MICROSOFT_365: Mark = { hex: "D83B01", path: MICROSOFT.path };

const MARKS: Record<string, Mark> = {
  slack: SLACK,
  discord: brand(siDiscord),
  telegram: brand(siTelegram),
  whatsapp: brand(siWhatsapp),
  email: EMAIL,
  matrix: brand(siMatrix),
  "google-chat": brand(siGooglechat),
  teams: TEAMS,
  mastodon: brand(siMastodon),
  bluesky: brand(siBluesky),
  x: brand(siX),
  linkedin: LINKEDIN,
  facebook: brand(siFacebook),
  caldav: CALENDAR,
  carddav: CONTACTS,
  apple: brand(siApple),
  "home-assistant": brand(siHomeassistant),
  rss: brand(siRss),
  weather: WEATHER,
  spotify: brand(siSpotify),
  tidal: brand(siTidal),
  dropbox: brand(siDropbox),
  things: brand(siThings),
  omnifocus: OMNIFOCUS,
  instagram: brand(siInstagram),
  github: brand(siGithub),
  gitlab: brand(siGitlab),
  gitea: brand(siGitea),
  motita: MOTITA,
  notion: brand(siNotion),
  trello: brand(siTrello),
  todoist: brand(siTodoist),
  linear: brand(siLinear),
  jira: brand(siJira),
  airtable: brand(siAirtable),
  nextcloud: brand(siNextcloud),
  "google-sheets": brand(siGooglesheets),
  "google-workspace": GOOGLE_WORKSPACE,
  "microsoft-365": MICROSOFT_365,
  gmail: brand(siGmail),
  kroki: KROKI,
  figma: brand(siFigma),
  excalidraw: brand(siExcalidraw),
  webhook: WEBHOOK,
  http: HTTP,
  shell: SHELL,
  stripe: brand(siStripe),
  zendesk: brand(siZendesk),
  ntfy: brand(siNtfy),
};

// Some brand marks are black and would vanish on the dark ground: they take the text colour.
const DARK_MARKS = new Set(["x", "notion", "matrix", "github", "apple", "tidal"]);

export function logoColor(kind: string): string {
  const m = MARKS[kind];
  if (!m) return "var(--color-accent)";
  // Near-black marks (GitHub, X) take the text colour so they show on either theme.
  const n = parseInt(m.hex, 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.2 ? "var(--t1)" : "#" + m.hex;
}

export default function ConnectorLogo({
  kind,
  size = 24,
  mono,
}: {
  kind: string;
  size?: number;
  mono?: boolean;
}) {
  const m = MARKS[kind];
  if (!m) {
    return (
      <span
        class="logo-fallback"
        style={`width:${size}px;height:${size}px;font-size:${size * 0.5}px`}
        aria-hidden="true"
      >
        {kind.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  const fill = mono || DARK_MARKS.has(kind) ? "currentColor" : "#" + m.hex;
  return (
    <svg
      width={size}
      height={size}
      viewBox={m.viewBox || "0 0 24 24"}
      role="img"
      aria-label={kind}
      class="logo"
    >
      <path d={m.path} fill={fill} />
    </svg>
  );
}

// ─── The providers of the models ──────────────────────────────────────────────────────────────
// Their marks from simple-icons where it carries them. OpenAI and Groq are not there: they get a
// plain mark of their own (a knot, a ring with a tail), and "another server" the globe.
const PROVIDER_MARKS: Record<string, Mark> = {
  anthropic: brand(siClaude),
  "claude-code": brand(siClaude),
  gemini: brand(siGooglegemini),
  ollama: brand(siOllama),
  "ollama-cloud": brand(siOllama),
  openrouter: brand(siOpenrouter),
  deepseek: brand(siDeepseek),
  mistral: brand(siMistralai),
  qwen: brand(siQwen),
  copilot: brand(siGithubcopilot),
  custom: HTTP,
};

const dark = (hex: string) => {
  const n = parseInt(hex, 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.2;
};

export function ProviderLogo({ kind, size = 24 }: { kind: string; size?: number }) {
  if (kind === "openai" || kind === "codex") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={kind} class="logo">
        <g fill="none" stroke="currentColor" stroke-width="1.7">
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <rect
              key={a}
              x="9"
              y="2.5"
              width="6"
              height="11"
              rx="3"
              transform={`rotate(${a} 12 12)`}
            />
          ))}
        </g>
      </svg>
    );
  }
  if (kind === "groq") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={kind} class="logo">
        <g fill="none" stroke="#F55036" stroke-width="2.6" stroke-linecap="round">
          <circle cx="11.5" cy="10" r="5.5" />
          <path d="M17 10v7.5a3.5 3.5 0 0 1-3.5 3.5H11" />
        </g>
      </svg>
    );
  }
  const m = PROVIDER_MARKS[kind];
  if (!m) {
    return (
      <span
        class="logo-fallback"
        style={`width:${size}px;height:${size}px;font-size:${size * 0.5}px`}
        aria-hidden="true"
      >
        {kind.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={m.viewBox || "0 0 24 24"}
      role="img"
      aria-label={kind}
      class="logo"
    >
      <path d={m.path} fill={dark(m.hex) ? "currentColor" : "#" + m.hex} />
    </svg>
  );
}
