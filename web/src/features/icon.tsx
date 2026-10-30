import type { ReactNode } from "react";

export type IconName = "sparkles" | "story" | "music" | "face" | "megaphone" | "poster" | "character" | "landscape" | "voice" | "template" | "chevron-left" | "chevron-right" | "rain" | "sun" | "moon" | "lock" | "unlock" | "play" | "dialogue" | "sliders";

const shapes: Record<IconName, ReactNode> = {
  sparkles: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14ZM5 3l.7 1.7L7.5 5.5l-1.8.7L5 8l-.7-1.8-1.8-.7 1.8-.8L5 3Z"/></>,
  story: <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
  music: <><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>,
  face: <><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14q3.5 4 7 0"/></>,
  megaphone: <><path d="m3 11 17-6v14L3 13zM7 14l2 6h4l-2-8"/><path d="M20 9h2M20 15h2"/></>,
  poster: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></>,
  character: <><circle cx="12" cy="8" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
  landscape: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/></>,
  voice: <><path d="M12 3v18M7 7v10M17 7v10M3 10v4M21 10v4"/></>,
  template: <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/></>,
  "chevron-left": <path d="m15 18-6-6 6-6"/>,
  "chevron-right": <path d="m9 18 6-6-6-6"/>,
  rain: <><path d="M4 14h15a3 3 0 0 0 0-6 5 5 0 0 0-9-2 4 4 0 0 0-6 4"/><path d="m8 17-1 3m6-3-1 3m6-3-1 3"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  moon: <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.4-2"/></>,
  play: <path d="m8 5 11 7-11 7z"/>,
  dialogue: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.7 8.7 0 0 1-3.5-.7L4 20l1.4-3.7A7 7 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z"/><path d="M8 11h8M8 14h5"/></>,
  sliders: <><path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/></>,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}
