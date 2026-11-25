'use client';

import { Flag, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { CHAT_MAX_LENGTH, type ChatMessage } from '@radiot/shared';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useSocketEvent } from '@/lib/realtime';
import { useMe } from '@/lib/session';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function Chat() {
  const t = useTranslations('Chat');
  const { me } = useMe();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    void api<{ messages: ChatMessage[] }>('/api/chat')
      .then((r) => setMessages(r.messages))
      .catch(() => {});
  }, []);
  useSocketEvent('chat:message', (m) =>
    setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms.slice(-99), m])),
  );
  useSocketEvent('chat:deleted', ({ id }) => setMessages((ms) => ms.filter((m) => m.id !== id)));
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    try {
      await api('/api/chat', { method: 'POST', json: { body } });
      setText('');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const report = (m: ChatMessage) =>
    api('/api/reports', {
      method: 'POST',
      json: {
        targetKind: 'chat',
        targetId: m.id,
        targetUserId: m.user.id,
        reason: 'Inappropriate chat message',
      },
    })
      .then(() => toast.success('Reported'))
      .catch((err: Error) => toast.error(err.message));
  const remove = (m: ChatMessage) =>
    api(`/api/admin/chat/${m.id}`, { method: 'DELETE' }).catch((err: Error) =>
      toast.error(err.message),
    );

  return (
    <section aria-labelledby="chat-title" className="flex h-[28rem] flex-col glass">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 id="chat-title" className="font-bold">
          {t('title')}
        </h2>
        <span className="legend">{t('eyebrow')}</span>
      </div>
      <ol
        ref={listRef}
        className="flex-1 space-y-2 overflow-y-auto px-4 py-3 text-sm"
        aria-live="polite"
        aria-relevant="additions"
      >
        {!messages.length && <li className="text-muted-foreground">{t('empty')}</li>}
        {messages.map((m) => (
          <li key={m.id} className="group flex items-start gap-2">
            <p className="min-w-0 flex-1 break-words">
              {m.user.handle ? (
                <Link
                  href={`/u/${m.user.handle}`}
                  className="font-semibold text-brand hover:underline"
                >
                  {m.user.name}
                </Link>
              ) : (
                <span className="font-semibold text-brand">{m.user.name}</span>
              )}{' '}
              {m.body}
            </p>
            {me && me.id !== m.user.id && (
              <button
                type="button"
                onClick={() => void report(m)}
                className="opacity-60 hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-60"
                aria-label={`${t('report')}: ${m.user.name}`}
              >
                <Flag className="size-3.5" aria-hidden />
              </button>
            )}
            {me?.role === 'admin' && (
              <button
                type="button"
                onClick={() => void remove(m)}
                className="opacity-60 hover:opacity-100"
                aria-label={t('delete')}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ol>
      {me ? (
        <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={CHAT_MAX_LENGTH}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
          />
          <Button type="submit" disabled={!text.trim()}>
            {t('send')}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
