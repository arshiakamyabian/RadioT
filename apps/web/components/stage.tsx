'use client';

import { Flag, Video, VideoOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Room } from 'livekit-client';
import type { StageState, StageToken } from '@radiot/shared';
import { api } from '@/lib/api';
import { track as trackEvent } from '@/lib/analytics';
import { useRadio } from '@/lib/radio';
import { useSocketEvent } from '@/lib/realtime';
import { useMe } from '@/lib/session';
import { openCamera } from '@/lib/stage/media';
import { DelayedVideo } from './delayed-video';
import { Button } from './ui/button';

export function Stage() {
  const t = useTranslations('Stage');
  const { me, profile, refresh } = useMe();
  const { now, streamDelaySeconds } = useRadio();
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<StageState>({ live: false, performer: null, roundId: null });
  const [remote, setRemote] = useState<MediaStreamTrack | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [ageOk, setAgeOk] = useState(false);
  const viewerRoom = useRef<Room | null>(null);
  const performerRoom = useRef<Room | null>(null);
  const localTrack = useRef<MediaStreamTrack | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    void api<{ enabled: boolean; state: StageState }>('/api/stage')
      .then((r) => {
        setEnabled(r.enabled);
        setState(r.state);
      })
      .catch(() => {});
  }, []);
  useSocketEvent('stage:state', setState);

  // Viewers subscribe only while someone is live.
  useEffect(() => {
    if (!enabled || !state.live || publishing) return;
    let cancelled = false;
    void (async () => {
      const [{ Room, RoomEvent, Track }, tok] = await Promise.all([
        import('livekit-client'),
        api<StageToken>('/api/stage/token', { method: 'POST', json: { role: 'viewer' } }),
      ]);
      if (cancelled) return;
      const room = new Room({ adaptiveStream: true });
      viewerRoom.current = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video && track.mediaStreamTrack)
          setRemote(track.mediaStreamTrack);
      });
      room.on(RoomEvent.TrackUnsubscribed, () => setRemote(null));
      await room.connect(tok.url, tok.token, { autoSubscribe: true });
    })().catch(() => {});
    return () => {
      cancelled = true;
      void viewerRoom.current?.disconnect();
      viewerRoom.current = null;
      setRemote(null);
    };
  }, [enabled, state.live, publishing]);

  const stop = useCallback(async () => {
    localTrack.current?.stop();
    localTrack.current = null;
    await performerRoom.current?.disconnect();
    performerRoom.current = null;
    setPublishing(false);
  }, []);

  useEffect(() => {
    const v = previewRef.current;
    if (!publishing || !v || !localTrack.current) return;
    v.srcObject = new MediaStream([localTrack.current]);
    void v.play().catch(() => {});
  }, [publishing]);

  // Leave the stage as soon as the song changes (the server also ends the session).
  const isOwner = Boolean(me && now?.kind === 'request' && now.requester?.id === me.id);
  useEffect(() => {
    if (!isOwner && publishing) void stop();
  }, [isOwner, publishing, stop]);

  async function goLive() {
    try {
      if (!profile?.ageConfirmedAdult) {
        await api('/api/me/profile', { method: 'PATCH', json: { ageConfirmedAdult: true } });
        refresh();
      }
      const video = await openCamera();
      localTrack.current = video;
      const [{ Room, Track }, tok] = await Promise.all([
        import('livekit-client'),
        api<StageToken>('/api/stage/token', { method: 'POST', json: { role: 'performer' } }),
      ]);
      const room = new Room();
      performerRoom.current = room;
      await room.connect(tok.url, tok.token, { autoSubscribe: false });
      // Only the camera track is ever published. setMicrophoneEnabled is never called.
      await room.localParticipant.publishTrack(video, {
        source: Track.Source.Camera,
        name: 'camera',
      });
      setPublishing(true);
      trackEvent('go_live');
    } catch (err) {
      await stop();
      toast.error(err instanceof DOMException ? t('cameraError') : (err as Error).message);
    }
  }

  async function report() {
    if (!state.performer) return;
    await api('/api/reports', {
      method: 'POST',
      json: {
        targetKind: 'stage',
        targetId: state.roundId ?? 'stage',
        targetUserId: state.performer.id,
        reason: 'Inappropriate live stream',
      },
    })
      .then(() => toast.success('Reported'))
      .catch((err: Error) => toast.error(err.message));
  }

  if (!enabled) return null;
  if (!state.live && !isOwner) return null;

  return (
    <section aria-labelledby="stage-title" className="glass p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="stage-title" className="flex items-center gap-2 font-bold">
          <Video className="size-4 text-accent" aria-hidden />
          {state.live && state.performer
            ? t('liveNow', { name: state.performer.name })
            : t('title')}
        </h2>
        {state.live && !publishing && me && (
          <Button variant="ghost" size="sm" onClick={() => void report()}>
            <Flag className="size-4" aria-hidden /> {t('report')}
          </Button>
        )}
      </div>

      {publishing ? (
        <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
          <video
            ref={previewRef}
            muted
            playsInline
            className="size-full -scale-x-100 object-cover"
            aria-label={t('title')}
          />
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-bold uppercase tracking-wider text-white backdrop-blur">
            <span aria-hidden className="size-2 rounded-full bg-live" />
            {t('youreLive')}
          </span>
        </div>
      ) : remote ? (
        <DelayedVideo
          track={remote}
          // Listeners hear the station on the server clock, so the performer's live video
          // already lines up; no HLS-style delay is needed.
          delaySeconds={streamDelaySeconds}
          label={state.performer ? t('liveNow', { name: state.performer.name }) : t('title')}
        />
      ) : null}

      {isOwner && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{t('noMic')}</p>
          {publishing ? (
            <Button variant="outline" onClick={() => void stop()}>
              <VideoOff className="size-4" aria-hidden /> {t('stop')}
            </Button>
          ) : (
            <>
              {!profile?.ageConfirmedAdult && (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={ageOk}
                    onChange={(e) => setAgeOk(e.target.checked)}
                    className="mt-1 size-4 accent-[var(--primary)]"
                  />
                  <span>{t('ageGate')}</span>
                </label>
              )}
              <Button
                onClick={() => void goLive()}
                disabled={!profile?.ageConfirmedAdult && !ageOk}
              >
                <Video className="size-4" aria-hidden /> {t('goLive')}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
