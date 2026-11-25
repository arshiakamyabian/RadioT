'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { transitionModeSchema, type StationSettings } from '@radiot/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useSocketEvent } from '@/lib/realtime';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';
import { TransitionPreview } from './transitions';

// Admin UI is English-only by design: a small trusted team, and it isn't indexed.
type Tab =
  | 'overview'
  | 'reports'
  | 'flags'
  | 'sanctions'
  | 'fallback'
  | 'transitions'
  | 'settings'
  | 'audit';
type Stats = {
  listeners: number;
  next: { title: string } | null;
  requests: Record<string, number>;
  openReports: number;
  openVoteFlags: number;
  fallbackReady: number;
  now: { title: string } | null;
  stage: { live: boolean; performer: { name: string } | null };
};
type Row = Record<string, unknown> & { id: string };

const fmt = (v: unknown) =>
  v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function Table({
  rows,
  cols,
  actions,
}: {
  rows: Row[];
  cols: [string, (r: Row) => unknown][];
  actions?: (r: Row) => React.ReactNode;
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing here.</p>;
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground">
          <tr>
            {cols.map(([h]) => (
              <th key={h} scope="col" className="px-3 py-2">
                {h}
              </th>
            ))}
            {actions && (
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border align-top">
              {cols.map(([h, get]) => (
                <td key={h} className="max-w-xs truncate px-3 py-2">
                  {fmt(get(r))}
                </td>
              ))}
              {actions && <td className="whitespace-nowrap px-3 py-2">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminDashboard() {
  const { me, pending } = useMe();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('overview');
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [settings, setSettings] = useState<StationSettings | null>(null);

  useEffect(() => {
    if (!pending && me?.role !== 'admin') router.push('/');
  }, [pending, me, router]);

  const act = useCallback(async (fn: () => Promise<unknown>, ok = 'Done') => {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, []);

  const load = useCallback(async () => {
    if (me?.role !== 'admin' || tab === 'transitions') return;
    const path: Record<Exclude<Tab, 'transitions'>, string> = {
      overview: '/api/admin/stats',
      reports: '/api/admin/reports',
      flags: '/api/admin/vote-flags',
      sanctions: '/api/admin/sanctions',
      fallback: '/api/admin/fallback',
      settings: '/api/admin/settings',
      audit: '/api/admin/audit',
    };
    const data = await api<Record<string, unknown>>(path[tab]).catch(() => null);
    if (!data) return;
    if (tab === 'overview') setStats(data as unknown as Stats);
    else if (tab === 'settings') setSettings((data as { settings: StationSettings }).settings);
    else setRows((Object.values(data)[0] as Row[]) ?? []);
  }, [me, tab]);
  useEffect(() => {
    void load();
  }, [load]);
  useSocketEvent('radio:now', () => tab === 'overview' && void load());

  if (me?.role !== 'admin') return null;

  const tabs: Tab[] = [
    'overview',
    'reports',
    'flags',
    'sanctions',
    'fallback',
    'transitions',
    'settings',
    'audit',
  ];
  const ban = (userId: string, kind: 'ban' | 'mute', minutes?: number) =>
    act(
      () =>
        api('/api/admin/sanctions', {
          method: 'POST',
          json: { kind, userId, minutes, reason: 'admin action' },
        }).then(load),
      `${kind === 'ban' ? 'Banned' : 'Muted'}`,
    );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-black">Admin</h1>
      <div role="tablist" aria-label="Admin sections" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm capitalize ring-1 ring-border',
              tab === t && 'bg-primary text-primary-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && stats && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Listeners', stats.listeners],
              ['Up next', stats.next?.title ?? '—'],
              ['In vote', stats.requests.ready ?? 0],
              ['Fallback tracks', stats.fallbackReady],
              ['Open reports', stats.openReports],
              ['Vote flags', stats.openVoteFlags],
              ['Now', stats.now?.title ?? '—'],
              ['Stage', stats.stage.live ? `LIVE: ${stats.stage.performer?.name}` : 'off'],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
                <p className="text-xs text-muted-foreground">{k}</p>
                <p className="truncate text-lg font-bold">{String(v)}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                void act(() => api('/api/admin/skip', { method: 'POST', json: {} }), 'Skipped')
              }
            >
              Skip current track
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void act(
                  () => api('/api/admin/stage/kill', { method: 'POST', json: {} }),
                  'Stage cleared',
                )
              }
            >
              End camera (kill switch)
            </Button>
          </div>
        </div>
      )}

      {tab === 'reports' && (
        <Table
          rows={rows}
          cols={[
            ['Kind', (r) => r.targetKind],
            ['Reason', (r) => r.reason],
            ['Target user', (r) => (r.targetUser as { name?: string } | null)?.name],
            ['Reporter', (r) => (r.reporter as { name?: string } | null)?.name],
            ['When', (r) => r.createdAt],
          ]}
          actions={(r) => (
            <div className="flex gap-1">
              {typeof r.targetUserId === 'string' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void ban(r.targetUserId as string, 'mute', 60)}
                >
                  Mute 1h
                </Button>
              )}
              {typeof r.targetUserId === 'string' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void ban(r.targetUserId as string, 'ban')}
                >
                  Ban
                </Button>
              )}
              {r.targetKind === 'chat' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void act(() =>
                      api(`/api/admin/chat/${String(r.targetId)}`, { method: 'DELETE' }),
                    )
                  }
                >
                  Delete msg
                </Button>
              )}
              <Button
                size="sm"
                onClick={() =>
                  void act(
                    () =>
                      api(`/api/admin/reports/${r.id}/resolve`, { method: 'POST', json: {} }).then(
                        load,
                      ),
                    'Resolved',
                  )
                }
              >
                Resolve
              </Button>
            </div>
          )}
        />
      )}

      {tab === 'flags' && (
        <Table
          rows={rows}
          cols={[
            ['Round', (r) => String(r.roundId).slice(0, 8)],
            ['IP hash', (r) => String(r.ipHash).slice(0, 10)],
            ['Accounts', (r) => (r.users as { name: string }[]).map((u) => u.name).join(', ')],
            ['When', (r) => r.createdAt],
          ]}
          actions={(r) => (
            <Button
              size="sm"
              onClick={() =>
                void act(
                  () =>
                    api(`/api/admin/vote-flags/${r.id}/review`, { method: 'POST', json: {} }).then(
                      load,
                    ),
                  'Reviewed',
                )
              }
            >
              Mark reviewed
            </Button>
          )}
        />
      )}

      {tab === 'sanctions' && (
        <Table
          rows={rows}
          cols={[
            ['Kind', (r) => r.kind],
            ['User', (r) => (r.user as { name?: string } | null)?.name ?? r.ipHash],
            ['Reason', (r) => r.reason],
            ['Expires', (r) => r.expiresAt ?? 'never'],
          ]}
          actions={(r) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void act(
                  () => api(`/api/admin/sanctions/${r.id}`, { method: 'DELETE' }).then(load),
                  'Lifted',
                )
              }
            >
              Lift
            </Button>
          )}
        />
      )}

      {tab === 'fallback' && (
        <Table
          rows={rows}
          cols={[
            ['Title', (r) => r.title],
            ['Artist', (r) => r.artist],
            ['Status', (r) => r.status],
            ['LUFS', (r) => r.lufs],
            ['Gain dB', (r) => r.gainDb],
            ['Xfade ms', (r) => r.crossfadeDurationMs],
            ['Plays', (r) => r.playCount],
          ]}
          actions={(r) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void act(() =>
                  api(`/api/admin/fallback/${r.id}`, {
                    method: 'PATCH',
                    json: { enabled: !r.enabled },
                  }).then(load),
                )
              }
            >
              {r.enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
        />
      )}

      {tab === 'transitions' && <TransitionPreview />}

      {tab === 'settings' && settings && (
        <form
          className="grid max-w-xl gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const patch: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(settings)) {
              if (typeof v === 'number') patch[k] = Number(f.get(k));
              else if (typeof v === 'boolean') patch[k] = f.get(k) === 'on';
              else if (typeof v === 'string') patch[k] = f.get(k);
              else if (Array.isArray(v))
                patch[k] = String(f.get(k) ?? '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
            }
            void act(
              () => api('/api/admin/settings', { method: 'PATCH', json: patch }).then(load),
              'Settings saved',
            );
          }}
        >
          {Object.entries(settings).map(([k, v]) => (
            <label key={k} className="flex items-center justify-between gap-4 text-sm">
              <span className="font-mono">{k}</span>
              {typeof v === 'boolean' ? (
                <input type="checkbox" name={k} defaultChecked={v} className="size-4" />
              ) : k === 'transitionMode' ? (
                <select
                  name={k}
                  defaultValue={String(v)}
                  className="h-10 w-full max-w-56 rounded-lg bg-background px-3 ring-1 ring-border"
                >
                  {transitionModeSchema.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  name={k}
                  defaultValue={Array.isArray(v) ? v.join(', ') : String(v)}
                  type={typeof v === 'number' ? 'number' : 'text'}
                  step="any"
                  className="max-w-56"
                />
              )}
            </label>
          ))}
          <Button type="submit">Save settings</Button>
        </form>
      )}

      {tab === 'audit' && (
        <Table
          rows={rows}
          cols={[
            ['When', (r) => r.createdAt],
            ['Admin', (r) => (r.admin as { name?: string } | null)?.name],
            ['Action', (r) => r.action],
            ['Target', (r) => r.target],
            ['Details', (r) => r.metadata],
          ]}
        />
      )}
    </div>
  );
}
