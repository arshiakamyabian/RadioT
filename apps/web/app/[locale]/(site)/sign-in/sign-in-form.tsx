'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { emailSchema, type Locale } from '@radiot/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { track } from '@/lib/analytics';
import { authClient } from '@/lib/auth-client';
import { localizedUrl } from '@/lib/seo';

type State =
  { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error' };

export function SignInForm({ locale, google }: { locale: Locale; google: boolean }) {
  const t = useTranslations('SignIn');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const callbackURL = localizedUrl(locale);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(new FormData(event.currentTarget).get('email'));
    if (!parsed.success) return setState({ kind: 'error' });
    setState({ kind: 'sending' });
    const { error } = await authClient.signIn.magicLink({ email: parsed.data, callbackURL });
    if (!error) track('sign_in_requested', { method: 'magic_link' });
    setState(error ? { kind: 'error' } : { kind: 'sent', email: parsed.data });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('subheading')}</p>
      </div>

      {state.kind === 'sent' ? (
        <p role="status" className="rounded-lg bg-card p-4">
          {t('sent', { email: state.email })}
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <Label htmlFor="email">{t('email')}</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
          <Button type="submit" disabled={state.kind === 'sending'}>
            {state.kind === 'sending' ? t('sending') : t('submit')}
          </Button>
          {state.kind === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              {t('error')}
            </p>
          )}
        </form>
      )}

      {google && (
        <>
          <div className="flex items-center gap-3 text-xs uppercase text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t('or')}
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              track('sign_in_requested', { method: 'google' });
              void authClient.signIn.social({ provider: 'google', callbackURL });
            }}
          >
            {t('google')}
          </Button>
        </>
      )}

      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        {t('back')}
      </Link>
    </div>
  );
}
