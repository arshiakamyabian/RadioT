import { STATION_NAME } from '@radiot/shared';
import { cn } from '@/lib/utils';

/** Antenna mast in the shape of a "T", broadcasting. Same drawing as /icon.svg. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn('size-7', className)}>
      <rect width="64" height="64" rx="15" fill="oklch(0.82 0.15 72)" />
      <path
        d="M22 19h20M32 19v30"
        stroke="var(--primary-foreground)"
        strokeWidth="5.5"
        strokeLinecap="round"
      />
      <path
        d="M15.5 13.5a20 20 0 0 0 0 23M48.5 13.5a20 20 0 0 1 0 23"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="32" cy="49" r="3" fill="var(--live)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      <span className="text-[1.05rem] font-extrabold tracking-tight text-foreground">
        {STATION_NAME.slice(0, -1)}
        <span className="text-brand">{STATION_NAME.slice(-1)}</span>
      </span>
    </span>
  );
}
