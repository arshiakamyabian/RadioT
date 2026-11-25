import { cn } from '@/lib/utils';

/** Studio "ON AIR" lamp. Lit while the station is broadcasting. */
export function OnAir({ label, lit = true }: { label: string; lit?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-2.5 py-1 font-mono text-[0.6875rem] font-bold tracking-[0.18em] uppercase',
        lit
          ? 'lamp-pulse border-[oklch(0.68_0.21_28/0.6)] bg-[oklch(0.68_0.21_28/0.14)] text-[oklch(0.8_0.15_30)] shadow-[0_0_18px_-4px_oklch(0.68_0.21_28/0.8)]'
          : 'border-border text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', lit ? 'bg-live' : 'bg-muted-foreground/50')}
      />
      {label}
    </span>
  );
}
