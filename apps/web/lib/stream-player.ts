import type Hls from 'hls.js';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'buffering' | 'error' | 'offline';

export interface PlayerSources {
  /** Master playlist of the adaptive stream (64k / 128k / 256k AAC). */
  hls: string;
  /** Icecast MP3 of the same program, for devices without HLS. */
  mp3: string;
}

type Mode = 'native' | 'hlsjs' | 'mp3';

/** Reconnect delays, ms: quick at first (a blip), then patient (a real outage). */
export const BACKOFF_MS = [800, 1600, 3200, 6000, 12_000, 20_000, 30_000];
/** Failures in a row on one transport before the other one is tried. */
const FAILS_BEFORE_SWITCH = 3;
/** The playhead must not stand still this long while "playing". */
const FROZEN_MS = 7000;
/** "Buffering" for this long means the connection is gone; rebuild it. */
const BUFFERING_MS = 9000;
/** A connection that played this long is a good one: forget earlier failures. */
const STABLE_MS = 12_000;

export const backoffDelay = (attempt: number, random = Math.random()) =>
  Math.round(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]! * (0.85 + 0.3 * random));

/** One <audio> element for the whole app. It outlives React, route changes and locale switches. */
export function getAudioElement(): HTMLAudioElement {
  const w = window as unknown as { __radiotAudio?: HTMLAudioElement };
  if (w.__radiotAudio?.isConnected) return w.__radiotAudio;
  const audio = document.createElement('audio');
  audio.id = 'radiot-audio';
  audio.dataset.testid = 'radio-audio';
  audio.preload = 'none';
  audio.autoplay = false;
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');
  audio.setAttribute('x-webkit-airplay', 'allow');
  audio.hidden = true;
  document.body.appendChild(audio);
  w.__radiotAudio = audio;
  return audio;
}

/** The one player of the page, created on first use and kept for the life of the document. */
export function getStreamPlayer(): StreamPlayer {
  const w = window as unknown as { __radiotPlayer?: StreamPlayer };
  w.__radiotPlayer ??= new StreamPlayer(getAudioElement(), (msg, data) => {
    try {
      if (localStorage.getItem('radiotDebug')) console.info('[radiot]', msg, data ?? '');
    } catch {
      // storage unavailable
    }
  });
  return w.__radiotPlayer;
}

/** Apple's WebKit plays HLS itself, with the lock screen and AirPlay integration; use that there. */
export function prefersNativeHls(audio: HTMLAudioElement, ua = navigator.userAgent) {
  if (!audio.canPlayType('application/vnd.apple.mpegurl')) return false;
  const ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(ua);
  return ios || safari;
}

function canPlayAac() {
  const ms = (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  const type = 'audio/mp4; codecs="mp4a.40.2"';
  try {
    return !!(window.MediaSource?.isTypeSupported(type) || ms?.isTypeSupported(type));
  } catch {
    return true;
  }
}

export const isMobile = (ua = navigator.userAgent) =>
  /Android|iP(hone|ad|od)|Mobile/i.test(ua) ||
  (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

interface NetworkInformation extends EventTarget {
  effectiveType?: string;
  type?: string;
}

/**
 * Plays the station's live stream. It never needs the page's JavaScript to keep audio going: the
 * element plays one long HLS stream, so a locked phone or a background tab carries on by itself.
 * Everything here is recovery: rebuilding the connection after drops, network switches and sleep.
 */
export class StreamPlayer {
  private hls: Hls | null = null;
  private mode: Mode | null = null;
  private sources: PlayerSources | null = null;
  private want = false;
  private attempt = 0;
  private fails: Record<Mode, number> = { native: 0, hlsjs: 0, mp3: 0 };
  private preferMp3 = false;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferingTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastTime = -1;
  private lastAdvance = 0;
  private status: PlayerStatus = 'idle';
  private teardownListeners: (() => void)[] = [];
  private ignorePauseUntil = 0;

  private statusListeners = new Set<(s: PlayerStatus) => void>();

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly debug: (msg: string, data?: unknown) => void = () => {},
  ) {
    // Adopt a stream that is already playing (the app's React tree was rebuilt around us).
    if (!audio.paused && audio.currentTime > 0) {
      this.status = 'playing';
      this.want = true;
    }
  }

  get current(): PlayerStatus {
    return this.status;
  }

  subscribe(fn: (s: PlayerStatus) => void) {
    this.statusListeners.add(fn);
    return () => void this.statusListeners.delete(fn);
  }

  get transport(): Mode | null {
    return this.mode;
  }

  /** Must run inside the tap that starts playback. */
  start(sources: PlayerSources) {
    this.sources = sources;
    this.want = true;
    this.attempt = 0;
    this.fails = { native: 0, hlsjs: 0, mp3: 0 };
    this.preferMp3 = false;
    this.listen();
    this.setStatus('loading');
    this.setSessionType('playback');
    void this.attach();
    this.setPlaybackState('playing');
  }

  stop() {
    this.want = false;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.bufferingTimer);
    clearTimeout(this.stableTimer);
    this.unlisten();
    this.teardown();
    this.setStatus('idle');
    this.setPlaybackState('paused');
  }

  setVolume(volume: number, muted: boolean) {
    this.audio.muted = muted;
    // iOS ignores element volume (the hardware buttons rule); elsewhere this is the slider.
    this.audio.volume = Math.min(1, Math.max(0, volume));
  }

  // ---- connection ------------------------------------------------------------------------------

  private async attach() {
    const gen = ++this.generation;
    this.teardown();
    const sources = this.sources;
    if (!sources || !this.want) return;
    const audio = this.audio;

    let mode: Mode = prefersNativeHls(audio) ? 'native' : 'hlsjs';
    let HlsCtor: typeof Hls | null = null;
    if (mode === 'hlsjs') {
      try {
        HlsCtor = (await import('hls.js')).default;
      } catch {
        HlsCtor = null;
      }
      if (gen !== this.generation) return;
      if (!HlsCtor?.isSupported())
        mode = audio.canPlayType('application/vnd.apple.mpegurl') ? 'native' : 'mp3';
      // The stream is AAC; a browser built without it (some Linux Chromiums) can only play the MP3.
      else if (!canPlayAac()) mode = 'mp3';
    }
    if (this.preferMp3) mode = 'mp3';
    this.mode = mode;
    audio.dataset.transport = mode;
    this.debug('attach', { mode, attempt: this.attempt });

    if (mode === 'hlsjs' && HlsCtor) {
      const mobile = isMobile();
      const hls = new HlsCtor({
        lowLatencyMode: false,
        // Stay a few segments behind the live edge: a live stream can only buffer what already
        // exists, so that distance (6 s, 10 s on phones) is the runway through a stall.
        liveSyncDurationCount: mobile ? 5 : 3,
        liveMaxLatencyDurationCount: 14,
        // Big buffers on phones: cellular connections stall for seconds, not milliseconds.
        maxBufferLength: mobile ? 45 : 30,
        maxMaxBufferLength: 90,
        maxBufferSize: 30 * 1000 * 1000,
        backBufferLength: 20,
        startLevel: 1,
        abrEwmaDefaultEstimate: mobile ? 600_000 : 2_000_000,
        abrBandWidthFactor: 0.8,
        abrBandWidthUpFactor: 0.6,
        enableWorker: true,
        manifestLoadPolicy: policy(6000, 10_000, 4),
        playlistLoadPolicy: policy(6000, 10_000, 6),
        fragLoadPolicy: policy(10_000, 30_000, 6),
      });
      this.hls = hls;
      hls.on(HlsCtor.Events.ERROR, (_e, data) => {
        this.debug('hls error', { type: data.type, details: data.details, fatal: data.fatal });
        if (!data.fatal) return;
        if (data.details === HlsCtor!.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) {
          this.preferMp3 = true;
          this.scheduleReconnect(true);
          return;
        }
        if (data.type === HlsCtor!.ErrorTypes.MEDIA_ERROR && this.attempt < 2) {
          hls.recoverMediaError();
          return;
        }
        this.fail('hls fatal ' + data.details);
      });
      hls.loadSource(sources.hls);
      hls.attachMedia(audio);
    } else if (mode === 'native') {
      audio.src = sources.hls;
    } else {
      // A fresh query string makes the browser open a new connection to the live point.
      audio.src = `${sources.mp3}${sources.mp3.includes('?') ? '&' : '?'}t=${Date.now()}`;
    }
    try {
      await audio.play();
    } catch (err) {
      if (gen !== this.generation) return;
      const name = (err as DOMException)?.name;
      this.debug('play() rejected', name);
      // Blocked until the next tap (autoplay rules, a call, Siri): let the user press play again.
      if (name === 'NotAllowedError') this.giveUp('idle');
      else if (name !== 'AbortError') this.fail('play rejected ' + name);
    }
  }

  private teardown() {
    this.stopWatchdog();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const a = this.audio;
    // pause() raises a `pause` event later; it must not be mistaken for the system pausing us.
    this.ignorePauseUntil = Date.now() + 600;
    a.pause();
    a.removeAttribute('src');
    a.load();
  }

  /** One failed attempt: rebuild after a growing pause; after a few, try the other transport. */
  private fail(reason: string) {
    if (!this.want) return;
    const mode = this.mode ?? 'hlsjs';
    this.fails[mode]++;
    this.debug('fail', { reason, mode, fails: this.fails[mode], attempt: this.attempt });
    if (this.fails[mode] >= FAILS_BEFORE_SWITCH) {
      this.preferMp3 = mode !== 'mp3';
      this.fails[mode] = 0;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(immediate = false) {
    if (!this.want) return;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.bufferingTimer);
    this.setStatus(navigator.onLine ? 'buffering' : 'offline');
    if (!navigator.onLine) return; // the `online` event restarts it
    const delay = immediate ? 0 : backoffDelay(this.attempt);
    this.attempt++;
    this.stopWatchdog();
    this.reconnectTimer = setTimeout(() => void this.attach(), delay);
  }

  private giveUp(status: PlayerStatus) {
    this.want = false;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.bufferingTimer);
    this.unlisten();
    this.teardown();
    this.setStatus(status);
    this.setPlaybackState('paused');
  }

  // ---- listening for trouble -------------------------------------------------------------------

  private listen() {
    this.unlisten();
    const a = this.audio;
    const on = <T extends EventTarget>(t: T, ev: string, fn: (e: Event) => void) => {
      t.addEventListener(ev, fn);
      this.teardownListeners.push(() => t.removeEventListener(ev, fn));
    };

    on(a, 'playing', () => {
      clearTimeout(this.bufferingTimer);
      this.setStatus('playing');
      this.setPlaybackState('playing');
      this.startWatchdog();
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
        this.fails = { native: 0, hlsjs: 0, mp3: 0 };
      }, STABLE_MS);
    });
    const buffering = () => {
      if (!this.want) return;
      this.setStatus('buffering');
      clearTimeout(this.bufferingTimer);
      this.bufferingTimer = setTimeout(() => this.fail('buffering too long'), BUFFERING_MS);
    };
    on(a, 'waiting', buffering);
    on(a, 'stalled', buffering);
    on(a, 'error', () => this.fail('media error'));
    on(a, 'ended', () => this.fail('stream ended'));
    on(a, 'pause', () => {
      // A pause nobody asked for (a phone call, Siri, headphones out): don't fight the system.
      if (this.want && !this.audio.ended && Date.now() > this.ignorePauseUntil) this.giveUp('idle');
    });

    // The phone changed networks (Wi-Fi <-> cellular) or woke up: connections made before are dead.
    on(window, 'online', () => {
      this.attempt = 0;
      if (this.want) this.scheduleReconnect(true);
    });
    on(window, 'offline', () => this.want && this.setStatus('offline'));
    const connection = (navigator as unknown as { connection?: NetworkInformation }).connection;
    if (connection) on(connection, 'change', () => this.onNetworkChange());
    on(
      document,
      'visibilitychange',
      () => document.visibilityState === 'visible' && this.catchUp(),
    );
    on(window, 'pageshow', () => this.catchUp());
    on(window, 'focus', () => this.catchUp());
  }

  private unlisten() {
    for (const off of this.teardownListeners) off();
    this.teardownListeners = [];
  }

  private onNetworkChange() {
    if (!this.want) return;
    this.debug('network changed');
    // Segment requests in flight on the old interface never finish; restart loading right away.
    if (this.hls) {
      this.hls.stopLoad();
      this.hls.startLoad(-1);
    } else if (this.status !== 'playing') {
      this.scheduleReconnect(true);
    }
  }

  /** Back in the foreground: if the buffer ran dry or we fell far behind, jump to the live edge. */
  private catchUp() {
    if (!this.want) return;
    const a = this.audio;
    if (a.paused && this.status === 'playing') {
      void a.play().catch(() => {});
    }
    const behind = this.secondsBehindLive();
    this.debug('catch up', { behind });
    if (behind !== null && behind > 15) this.seekToLive();
    else if (this.status === 'buffering' || a.readyState < 3) this.scheduleReconnect(true);
  }

  secondsBehindLive(): number | null {
    const a = this.audio;
    if (this.hls && this.hls.liveSyncPosition) return this.hls.liveSyncPosition - a.currentTime;
    if (a.seekable.length) return a.seekable.end(a.seekable.length - 1) - a.currentTime;
    return null;
  }

  private seekToLive() {
    const a = this.audio;
    if (this.hls?.liveSyncPosition) a.currentTime = this.hls.liveSyncPosition;
    else if (a.seekable.length)
      a.currentTime = Math.max(0, a.seekable.end(a.seekable.length - 1) - 6);
  }

  // ---- watchdog --------------------------------------------------------------------------------

  /** A "playing" element whose playhead stands still is dead, whatever it reports. */
  private startWatchdog() {
    this.stopWatchdog();
    this.lastTime = this.audio.currentTime;
    this.lastAdvance = Date.now();
    this.watchdog = setInterval(() => {
      const a = this.audio;
      if (!this.want || a.paused) return;
      if (Math.abs(a.currentTime - this.lastTime) > 0.05) {
        this.lastTime = a.currentTime;
        this.lastAdvance = Date.now();
      } else if (Date.now() - this.lastAdvance > FROZEN_MS) {
        this.fail('playhead frozen');
      }
    }, 2000);
  }

  private stopWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  // ---- platform integration --------------------------------------------------------------------

  private setStatus(s: PlayerStatus) {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  /** Safari: tell the OS this is media playback (keeps playing when locked, ducks nothing). */
  private setSessionType(type: 'playback' | 'auto') {
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = type;
    } catch {
      // not supported
    }
  }

  private setPlaybackState(state: 'playing' | 'paused') {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }
}

const policy = (ttfbMs: number, loadMs: number, retries: number) => ({
  default: {
    maxTimeToFirstByteMs: ttfbMs,
    maxLoadTimeMs: loadMs,
    timeoutRetry: {
      maxNumRetry: retries,
      retryDelayMs: 1000,
      maxRetryDelayMs: 8000,
      backoff: 'exponential' as const,
    },
    errorRetry: {
      maxNumRetry: retries,
      retryDelayMs: 1000,
      maxRetryDelayMs: 8000,
      backoff: 'exponential' as const,
    },
  },
});
