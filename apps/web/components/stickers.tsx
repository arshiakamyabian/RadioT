import type { ReactNode } from 'react';
import type { ReactionSticker } from '@radiot/shared';
import { cn } from '@/lib/utils';

const LINE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const ICON: Record<ReactionSticker, ReactNode> = {
  fire: (
    <path
      {...LINE}
      d="M32 14c4 7 11 11 11 21a11 11 0 0 1-22 0c0-5 2-8 5-11 0 4 2 6 4 6-1-6 0-11 2-16z"
    />
  ),
  airhorn: (
    <g {...LINE}>
      <rect x="15" y="27" width="9" height="13" rx="2" />
      <path d="M24 30l17-7v21l-17-7z" />
      <path d="M45 27l4-2M46 33.5h5M45 40l4 2" />
    </g>
  ),
  rewind: (
    <g {...LINE}>
      <path d="M21 25a14 14 0 1 1-3 10" />
      <path d="M17 19v8h8" />
      <path d="M30 28v8l5 3" />
    </g>
  ),
};

/** Round faceplate badge: charcoal disc, amber ring and line icon. */
export function Sticker({ id, className }: { id: ReactionSticker; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn('text-brand', className)}>
      <circle cx="32" cy="32" r="30" fill="oklch(0.17 0.007 75)" />
      <circle
        cx="32"
        cy="32"
        r="29"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".55"
        strokeWidth="1.5"
      />
      <g transform="translate(0 -1.5)">{ICON[id]}</g>
    </svg>
  );
}
