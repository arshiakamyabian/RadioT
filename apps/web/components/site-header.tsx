'use client';

import { Radio } from 'lucide-react';
import { motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import { Button } from './ui/button';

export function SiteHeader() {
  const t = useTranslations('Nav');
  const locale = useLocale();
  const pathname = usePathname();
  const { me, pending } = useMe();
  const links = [
    { href: '/', label: t('home') },
    { href: '/charts', label: t('charts') },
    { href: '/recent', label: t('recent') },
    ...(me?.role === 'admin' ? [{ href: '/admin', label: t('admin') }] : []),
  ];

  return (
    <header className="sticky top-0 z-40 px-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] sm:px-4">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {t('skip')}
      </a>
      <div className="glass mx-auto flex h-14 max-w-6xl items-center gap-2 rounded-full! py-0! pr-2 pl-3 sm:pl-4">
        <Link href="/" className="rounded-md">
          <Logo />
        </Link>
        <Nav
          links={links}
          pathname={pathname}
          pillId="nav-pill-desktop"
          className="ml-4 hidden flex-1 items-center gap-1 sm:flex"
        />
        <div className="flex-1 sm:hidden" />
        <Link
          href={pathname}
          locale={locale === 'tr' ? 'en' : 'tr'}
          hrefLang={locale === 'tr' ? 'en' : 'tr'}
          aria-label={t('language')}
          className="rounded-md px-2 py-1.5 font-mono text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {locale === 'tr' ? 'EN' : 'TR'}
        </Link>
        {/* Guest mode: no sign-in UI. Everyone gets a guest account automatically. */}
        {!pending && me && (
          <Link
            href="/settings"
            className="hidden max-w-28 truncate rounded-full px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-white/10 hover:text-foreground sm:block"
          >
            {me.handle ? `@${me.handle}` : t('profile')}
          </Link>
        )}
        <Button asChild size="sm" className="sheen rounded-full">
          <Link href="/request">
            <Radio className="size-4" aria-hidden />
            {t('request')}
          </Link>
        </Button>
      </div>
      <Nav
        links={links}
        pathname={pathname}
        pillId="nav-pill-mobile"
        className="glass mx-auto mt-2 flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-full! p-1! sm:hidden"
      />
    </header>
  );
}

function Nav({
  links,
  pathname,
  className,
  pillId,
}: {
  links: { href: string; label: string }[];
  pathname: string;
  className: string;
  pillId: string;
}) {
  return (
    <nav aria-label="Main" className={cn('isolate', className)}>
      {links.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
              active && 'text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                className="absolute inset-0 -z-10 rounded-full bg-white/10 ring-1 ring-white/10"
                aria-hidden
              />
            )}
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
