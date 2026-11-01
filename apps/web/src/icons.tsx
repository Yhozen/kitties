import type { JSX } from "preact";

type P = { size?: number; class?: string };
const svg = (p: P, children: JSX.Element | JSX.Element[]) => (
  <svg
    width={p.size || 16}
    height={p.size || 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={p.class}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconPlus = (p: P) => svg(p, [<path d="M12 5v14" />, <path d="M5 12h14" />]);
export const IconSend = (p: P) =>
  svg(p, [<path d="M22 2 11 13" />, <path d="M22 2 15 22l-4-9-9-4 20-7z" />]);
export const IconMonitor = (p: P) =>
  svg(p, [<rect x="2" y="3" width="20" height="14" rx="1" />, <path d="M8 21h8M12 17v4" />]);
export const IconBrain = (p: P) =>
  svg(p, [
    <path d="M9.5 2a2.5 2.5 0 0 1 2.5 2.5V20a2 2 0 0 1-4 0v-1a3 3 0 0 1-3-3 3 3 0 0 1-1-5.8A3 3 0 0 1 5 6a3 3 0 0 1 4.5-4z" />,
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5V20a2 2 0 0 0 4 0v-1a3 3 0 0 0 3-3 3 3 0 0 0 1-5.8A3 3 0 0 0 19 6a3 3 0 0 0-4.5-4z" />,
  ]);
export const IconUsers = (p: P) =>
  svg(p, [
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />,
    <circle cx="9" cy="7" r="4" />,
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />,
  ]);
export const IconStop = (p: P) => svg(p, [<rect x="5" y="5" width="14" height="14" rx="1" />]);
export const IconPlay = (p: P) => svg(p, [<path d="M6 4l14 8-14 8z" />]);
export const IconTrash = (p: P) =>
  svg(p, [<path d="M3 6h18" />, <path d="M8 6V4h8v2" />, <path d="M19 6l-1 14H6L5 6" />]);
export const IconSettings = (p: P) =>
  svg(p, [
    <circle cx="12" cy="12" r="3" />,
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />,
  ]);
export const IconSun = (p: P) =>
  svg(p, [
    <circle cx="12" cy="12" r="4" />,
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
  ]);
export const IconX = (p: P) => svg(p, [<path d="M18 6 6 18" />, <path d="M6 6l12 12" />]);
export const IconCamera = (p: P) =>
  svg(p, [
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />,
    <circle cx="12" cy="13" r="4" />,
  ]);
export const IconExpand = (p: P) =>
  svg(p, [
    <path d="M15 3h6v6" />,
    <path d="M9 21H3v-6" />,
    <path d="M21 3l-7 7" />,
    <path d="M3 21l7-7" />,
  ]);
export const IconReduce = (p: P) =>
  svg(p, [
    <path d="M4 14h6v6" />,
    <path d="M20 10h-6V4" />,
    <path d="M14 10l7-7" />,
    <path d="M3 21l7-7" />,
  ]);
export const IconMenu = (p: P) =>
  svg(p, [<path d="M3 6h18" />, <path d="M3 12h18" />, <path d="M3 18h18" />]);
export const IconBook = (p: P) =>
  svg(p, [
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />,
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />,
  ]);

export const IconHand = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M18 11V6a2 2 0 0 0-4 0v1" />
    <path d="M14 10V4a2 2 0 0 0-4 0v2" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </svg>
);
export const IconClock = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const IconTarget = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
);

export const IconThumbUp = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M7 10v11H3V10z" />
    <path d="M7 10l4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.8a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 18 21H7" />
  </svg>
);
export const IconThumbDown = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M17 14V3h4v11z" />
    <path d="M17 14l-4 8a2.5 2.5 0 0 1-2.5-2.5V15H4.7a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 6 3h11" />
  </svg>
);
export const IconShield = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

export const IconLogOut = (p: P) =>
  svg(p, [
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />,
    <path d="m16 17 5-5-5-5" />,
    <path d="M21 12H9" />,
  ]);
