'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import {
  streamStateSchema,
  trackHeardAt,
  type NowPlaying,
  type StreamState,
  type UpNext,
} from '@radiot/shared';
import { track } from './analytics';
import { ENGINE_URL, STREAM_BASE } from './env';
import { useRealtime, useSocketEvent } from './realtime';
import { getStreamPlayer, isMobile, type PlayerStatus } from './stream-player';

export type RadioStatus = PlayerStatus;

interface RadioState {
  status: RadioStatus;
  /** What listeners are hearing right now (the stream runs a few seconds behind the engine). */
  now: NowPlaying | null;
  next: UpNext | null;
  listeners: number;
  volume: number;
  muted: boolean;
  /** The station clock as heard: server time minus the stream's delay. Use for progress bars. */
  serverNow: () => number;
  /** Seconds the stream runs behind the engine (for syncing live video to the audio). */
  streamDelaySeconds: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
}

const Ctx = createContext<RadioState | null>(null);

/** Phones sit two segments (4 s) further behind the live edge (see StreamPlayer). */
const MOBILE_EXTRA_DELAY_MS = 4000;
const POLL_MS = 10_000;
const FALLBACK_POLL_MS = 3000;

export function RadioProvider({
  children,
  initialNow,
}: {
  children: ReactNode;
  initialNow: NowPlaying | null;
}) {
  const playerRef = useRef<ReturnType<typeof getStreamPlayer> | null>(null);
  const streamRef = useRef<StreamState | null>(null);
  const offsetRef = useRef(0);
  const [status, setStatus] = useState<RadioStatus>('idle');
  const [stream, setStream] = useState<StreamState | null>(null);
  const [heard, setHeard] = useState<NowPlaying | null>(initialNow);
  const heardRef = useRef(initialNow);
  const [listeners, setListeners] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const { socket, connected } = useRealtime();
  const wantRef = useRef(false);

  const delayMs = (stream?.streamDelayMs ?? 9000) + (isMobileNow() ? MOBILE_EXTRA_DELAY_MS : 0);
  const delayRef = useRef(delayMs);
  delayRef.current = delayMs;

  /** Server time minus the delay: the moment of the program a listener is hearing. */
  const serverNow = useCallback(() => Date.now() + offsetRef.current - delayRef.current, []);

  const applyState = useCallback((s: StreamState, sentAt: number) => {
    const received = Date.now();
    offsetRef.current = Date.parse(s.serverTime) - (sentAt + received) / 2;
    streamRef.current = s;
    setStream(s);
  }, []);

  // The engine publishes what is on air; SSE pushes changes, a slow poll covers dropped sockets
  // and phones that were asleep.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const sentAt = Date.now();
      try {
        const res = await fetch(`${STREAM_BASE}/now`, { cache: 'no-store' });
        if (!res.ok) return;
        const parsed = streamStateSchema.safeParse(await res.json());
        if (parsed.success && !cancelled) applyState(parsed.data, sentAt);
      } catch {
        // engine unreachable: keep showing the last known state
      }
    };
    void load();
    // Live pushes come straight from the engine; where its host is blocked, poll the proxy faster.
    let pushing = false;
    let lastLoad = Date.now();
    const poll = setInterval(() => {
      if (Date.now() - lastLoad < (pushing ? POLL_MS : FALLBACK_POLL_MS)) return;
      lastLoad = Date.now();
      void load();
    }, 1000);
    let source: EventSource | null = null;
    let errors = 0;
    try {
      source = new EventSource(`${ENGINE_URL}/events`);
      source.onopen = () => {
        pushing = true;
        errors = 0;
      };
      source.onerror = () => {
        pushing = false;
        // Blocked (not just a blip): stop retrying, polling carries on alone.
        if (++errors >= 3) source?.close();
      };
      source.addEventListener('state', (e) => {
        const parsed = streamStateSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
        if (parsed.success) applyState(parsed.data, Date.now());
      });
    } catch {
      // no EventSource: polling alone still works
    }
    const visible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', visible);
    return () => {
      cancelled = true;
      clearInterval(poll);
      source?.close();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [applyState]);

  // Which track the listener is hearing: the newest one that had started `delay` ago.
  useEffect(() => {
    const pick = () => {
      const s = streamRef.current;
      if (!s) return;
      const t = trackHeardAt(s, serverNow());
      const cur = heardRef.current;
      if (cur?.trackId === t?.trackId && cur?.startedAt === t?.startedAt) return;
      heardRef.current = t;
      // Cover and title morph into the next track where the browser supports View Transitions.
      if (cur && document.visibilityState === 'visible' && document.startViewTransition) {
        document.startViewTransition(() => flushSync(() => setHeard(t)));
      } else {
        setHeard(t);
      }
    };
    pick();
    const id = setInterval(pick, 500);
    return () => clearInterval(id);
  }, [serverNow, stream]);

  const next =
    stream?.next && heard && stream.now && heard.startedAt === stream.now.startedAt
      ? stream.next
      : null;

  useSocketEvent('radio:listeners', setListeners);

  useEffect(() => {
    const player = getStreamPlayer();
    playerRef.current = player;
    wantRef.current = player.current !== 'idle';
    setStatus(player.current);
    return player.subscribe((s) => {
      wantRef.current = s !== 'idle' && s !== 'error';
      setStatus(s);
    });
  }, []);

  useEffect(() => {
    if (connected) socket?.emit('radio:listen', wantRef.current);
  }, [connected, socket]);

  const play = useCallback(() => {
    wantRef.current = true;
    socket?.emit('radio:listen', true);
    track('listen_start');
    // HLS through the site's origin; the MP3 fallback is one endless response, which a proxy
    // would cut, so it goes to the engine directly.
    const hls = `${STREAM_BASE}/hls/radiot.m3u8`;
    const mp3 = streamRef.current?.mp3Url ?? `${ENGINE_URL}/radiot.mp3`;
    playerRef.current?.setVolume(volume, muted);
    // Runs inside the tap: the element is unlocked for the rest of the page's life.
    playerRef.current?.start({ hls, mp3 });
  }, [socket, volume, muted]);

  const pause = useCallback(() => {
    wantRef.current = false;
    socket?.emit('radio:listen', false);
    playerRef.current?.stop();
  }, [socket]);

  const toggle = useCallback(() => (wantRef.current ? pause() : play()), [pause, play]);

  // Lock-screen and headset controls (iOS, Android, desktop media keys).
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title: heard?.title ?? 'RadioT',
      artist:
        heard?.artist ||
        (heard?.requester ? `Requested by ${heard.requester.name}` : 'Live community radio'),
      album: 'RadioT — live',
      artwork: [
        {
          src: heard?.artworkUrl ?? '/icon.svg',
          sizes: '512x512',
          type: heard?.artworkUrl ? 'image/jpeg' : 'image/svg+xml',
        },
      ],
    });
    ms.setActionHandler('play', play);
    ms.setActionHandler('pause', pause);
    ms.setActionHandler('stop', pause);
    // A live stream has nothing to seek in or skip.
    for (const action of [
      'seekbackward',
      'seekforward',
      'seekto',
      'previoustrack',
      'nexttrack',
    ] as const) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // action not supported by this browser
      }
    }
  }, [heard, play, pause]);

  useEffect(() => {
    playerRef.current?.setVolume(volume, muted);
  }, [volume, muted]);

  const value: RadioState = {
    status,
    now: heard,
    next,
    listeners,
    volume,
    muted,
    serverNow,
    streamDelaySeconds: delayMs / 1000,
    play,
    pause,
    toggle,
    setVolume: setVolumeState,
    toggleMute: () => setMuted((m) => !m),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function isMobileNow() {
  return typeof navigator !== 'undefined' && isMobile();
}

export function useRadio() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRadio must be used inside RadioProvider');
  return v;
}
