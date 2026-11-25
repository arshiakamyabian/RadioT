import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, getSettings, schema, type Database } from '@radiot/db';
import {
  ALLOWED_CODECS,
  MIN_TRACK_SECONDS,
  type MediaJob,
  type StationSettings,
  type TrackAnalysis,
  type WorkerEvent,
  viaYtdlp,
} from '@radiot/shared';
import {
  FINGERPRINT_MATCH_THRESHOLD,
  computeGain,
  fingerprintSimilarity,
} from './media/analysis.js';
import { ANALYSIS_RATE, analyzeTrack } from './media/features.js';
import {
  RENDER_RATE,
  STEM_RENDER_OPTIONS,
  renderTransition,
  type Decode,
  type DecodeStems,
} from './media/render.js';
import { analyzeWithModels, stemDecoder, type MlConfig } from './media/ml.js';
import type { MediaTools, Probe } from './media/tools.js';
import { DownloadError, downloadPublic, downloadWithYtdlp } from './net.js';
import type { Storage } from './storage.js';

/** A problem with the submitted audio itself. Not retried; the request is rejected with this reason. */
export class RejectError extends Error {}

export interface PipelineDeps {
  db: Database;
  storage: Storage;
  tools: MediaTools;
  publish: (event: WorkerEvent) => Promise<void>;
  log: { info: (o: object, msg: string) => void };
  download?: typeof downloadPublic;
  /** yt-dlp binary for SoundCloud links and Spotify songs. */
  ytdlp?: string;
  /** Pretrained-model analysis; off when `python` is unset. */
  ml?: MlConfig;
}

export function validateProbe(probe: Probe, sizeBytes: number, s: StationSettings) {
  const audio = probe.streams.find((st) => st.codec_type === 'audio');
  if (!audio) throw new RejectError('No audio stream found');
  if (!audio.codec_name || !(ALLOWED_CODECS as readonly string[]).includes(audio.codec_name)) {
    throw new RejectError(`Unsupported audio codec: ${audio.codec_name ?? 'unknown'}`);
  }
  const duration = probe.format.duration ?? 0;
  if (duration < MIN_TRACK_SECONDS)
    throw new RejectError(`Audio is shorter than ${MIN_TRACK_SECONDS} seconds`);
  if (duration > s.maxDurationMinutes * 60) {
    throw new RejectError(`Audio is longer than ${s.maxDurationMinutes} minutes`);
  }
  if (sizeBytes > s.maxUploadMb * 1024 * 1024)
    throw new RejectError(`File is larger than ${s.maxUploadMb} MB`);
  const tags = Object.fromEntries(
    Object.entries({ ...probe.format.tags, ...audio.tags }).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    title: tags.title?.trim() ?? '',
    artist: (tags.artist ?? tags.album_artist)?.trim() ?? '',
  };
}

async function sha256(file: string) {
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function titleFromFilename(key: string) {
  const base = key.split('/').pop() ?? 'Untitled';
  return (
    base
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || 'Untitled'
  );
}

/** Loudness, cue points and the deep analysis (tempo, key, intro/outro...) of a cooked file. */
export async function analyzeCooked(
  cooked: string,
  tools: MediaTools,
  targetLufs: number,
): Promise<TrackAnalysis> {
  const [loud, pcm] = await Promise.all([tools.loudness(cooked), tools.pcm(cooked, ANALYSIS_RATE)]);
  const deep = analyzeTrack({ left: pcm.channels[0], right: pcm.channels[1] });
  const fadeFrom = Math.max(deep.cueInMs, deep.features.outro.fadeStartMs);
  return {
    durationMs: deep.durationMs,
    lufs: loud.lufs,
    truePeak: loud.truePeak,
    gainDb: computeGain(loud.lufs, loud.truePeak, targetLufs),
    cueInMs: deep.cueInMs,
    cueOutMs: deep.cueOutMs,
    // Used only by the plain crossfade (tracks without a plan, or players without the clip).
    crossfadeStartMs: fadeFrom,
    crossfadeDurationMs: Math.min(12_000, Math.max(2_000, deep.cueOutMs - fadeFrom)),
    features: deep.features,
  };
}

type TrackRow = typeof schema.fallbackTracks.$inferSelect | typeof schema.requests.$inferSelect;

/**
 * Stems, beats and structure from the pretrained models, stored once per track. Runs after the
 * track is marked ready; until it lands the planner uses the DSP analysis.
 */
async function addModelAnalysis(
  kind: 'fallback' | 'request',
  id: string,
  cooked: string,
  deps: PipelineDeps,
) {
  if (!deps.ml?.python) return;
  const ai = await analyzeWithModels(deps.ml, deps.storage, cooked, `stems/${kind}/${id}/`);
  if (!ai) return;
  const table = kind === 'fallback' ? schema.fallbackTracks : schema.requests;
  await deps.db.update(table).set({ ai }).where(eq(table.id, id));
  deps.log.info(
    { kind, id, bpm: ai.bpm, sections: ai.segments.map((s) => s.label), timings: ai.timings },
    'model analysis stored',
  );
}

async function findTrack(db: Database, id: string): Promise<TrackRow | null> {
  return (
    (await db.query.requests.findFirst({ where: eq(schema.requests.id, id) })) ??
    (await db.query.fallbackTracks.findFirst({ where: eq(schema.fallbackTracks.id, id) })) ??
    null
  );
}

/** Recomputes the analysis of an already cooked track (e.g. after the analysis improved). */
export async function reanalyze(job: MediaJob, deps: PipelineDeps) {
  const { db, storage, tools } = deps;
  const table = job.kind === 'reanalyze-fallback' ? schema.fallbackTracks : schema.requests;
  const [row] = await db.select().from(table).where(eq(table.id, job.id));
  if (!row?.storageKey) return;
  const dir = await mkdtemp(join(tmpdir(), 'radiot-'));
  try {
    const cooked = join(dir, 'cooked.mp3');
    await storage.download(row.storageKey, cooked);
    const settings = await getSettings(db);
    const analysis = await analyzeCooked(cooked, tools, settings.lufsTarget);
    await db
      .update(table)
      .set({ ...analysis, analyzedAt: new Date() })
      .where(eq(table.id, job.id));
    deps.log.info({ ...job, bpm: analysis.features?.bpm ?? null }, 'track reanalyzed');
    if (!row.ai) {
      await addModelAnalysis(
        job.kind === 'reanalyze-fallback' ? 'fallback' : 'request',
        job.id,
        cooked,
        deps,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Renders the clip for a `transitions` row and tells the API it is ready. */
export async function renderTransitionJob(job: MediaJob, deps: PipelineDeps) {
  const { db, storage, tools } = deps;
  const row = await db.query.transitions.findFirst({ where: eq(schema.transitions.id, job.id) });
  if (!row || row.status === 'ready') return;
  const dir = await mkdtemp(join(tmpdir(), 'radiot-'));
  try {
    const [a, b] = await Promise.all([findTrack(db, row.fromId), findTrack(db, row.toId)]);
    if (!a?.storageKey || !b?.storageKey) throw new Error('track of the pair is gone');
    const fileA = join(dir, 'a.mp3');
    const fileB = join(dir, 'b.mp3');
    await Promise.all([
      storage.download(a.storageKey, fileA),
      storage.download(b.storageKey, fileB),
    ]);
    const decoder =
      (file: string): Decode =>
      (fromSec, durationSec) =>
        tools.pcm(file, RENDER_RATE, { fromSec, durationSec });
    const side = (t: TrackRow) => ({
      cueInMs: t.cueInMs ?? 0,
      cueOutMs: t.cueOutMs ?? t.durationMs ?? 0,
      gainDb: t.gainDb ?? 0,
    });
    // AI plans mix per stem; without the stems the same plan renders with its band curves.
    let stems: { a: DecodeStems; b: DecodeStems } | undefined;
    if (row.plan.stems && a.ai && b.ai) {
      const [sa, sb] = await Promise.all([
        stemDecoder(storage, a.ai, join(dir, 'stems-a'), deps.ml?.ffmpeg ?? 'ffmpeg'),
        stemDecoder(storage, b.ai, join(dir, 'stems-b'), deps.ml?.ffmpeg ?? 'ffmpeg'),
      ]).catch(() => [null, null] as const);
      if (sa && sb) stems = { a: sa, b: sb };
    }
    const out = await renderTransition(
      decoder(fileA),
      decoder(fileB),
      side(a),
      side(b),
      row.plan,
      stems ? STEM_RENDER_OPTIONS : {},
      stems,
    );

    const frames = out.channels[0].length;
    const inter = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      inter[2 * i] = out.channels[0][i]!;
      inter[2 * i + 1] = out.channels[1][i]!;
    }
    const raw = join(dir, 'clip.f32');
    const clip = join(dir, 'clip.mp3');
    await writeFile(raw, Buffer.from(inter.buffer));
    await tools.encodeMp3(raw, out.sampleRate, clip);
    const clipKey = `transitions/${row.id}.mp3`;
    await storage.upload(clipKey, clip, 'audio/mpeg');
    await db
      .update(schema.transitions)
      .set({
        status: 'ready',
        error: null,
        clipKey,
        clip: {
          aFileStartMs: out.aFileStartMs,
          leadInMs: out.leadInMs,
          overlapMs: out.overlapMs,
          handoffClipMs: out.handoff.clipMs,
          handoffFileMs: out.handoff.bFileMs,
          clipMs: out.clipMs,
        },
        metrics: out.metrics,
        updatedAt: new Date(),
      })
      .where(eq(schema.transitions.id, row.id));
    await deps.publish({ type: 'transition.ready', transitionId: row.id });
    deps.log.info(
      { ...job, style: row.plan.style, stems: !!stems, ...out.metrics },
      'transition rendered',
    );
  } catch (err) {
    await db
      .update(schema.transitions)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(schema.transitions.id, row.id));
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function processMedia(job: MediaJob, deps: PipelineDeps) {
  if (job.kind === 'transition') return renderTransitionJob(job, deps);
  if (job.kind === 'reanalyze-fallback' || job.kind === 'reanalyze-request')
    return reanalyze(job, deps);
  const { db, storage, tools } = deps;
  const settings = await getSettings(db);
  const dir = await mkdtemp(join(tmpdir(), 'radiot-'));
  const raw = join(dir, 'raw');
  const cooked = join(dir, 'cooked.mp3');
  const art = join(dir, 'art.jpg');

  try {
    // ingest
    const target =
      job.kind === 'fallback'
        ? await db.query.fallbackTracks.findFirst({ where: eq(schema.fallbackTracks.id, job.id) })
        : await db.query.requests.findFirst({ where: eq(schema.requests.id, job.id) });
    if (!target) throw new RejectError('Track no longer exists');

    if (job.kind === 'request') {
      const req = target as typeof schema.requests.$inferSelect;
      await db
        .update(schema.requests)
        .set({ status: 'ingesting', updatedAt: new Date() })
        .where(eq(schema.requests.id, req.id));
      if (req.source === 'url') {
        if (!req.rawUrl) throw new RejectError('Missing URL');
        try {
          const maxBytes = settings.maxUploadMb * 1024 * 1024;
          if (viaYtdlp(req.rawUrl))
            await downloadWithYtdlp(req.rawUrl, raw, maxBytes, deps.ytdlp ?? 'yt-dlp');
          else await (deps.download ?? downloadPublic)(req.rawUrl, raw, maxBytes);
        } catch (err) {
          // Slow or flaky hosts get retried by runMediaJob; only definitive failures reject right away.
          const msg = `Could not download audio: ${(err as Error).message}`;
          if (err instanceof DownloadError && err.permanent) throw new RejectError(msg);
          if (
            (err as Error).message.includes('private address') ||
            (err as Error).message.includes('size limit')
          )
            throw new RejectError(msg);
          throw new Error(msg, { cause: err });
        }
      } else {
        if (!req.rawKey) throw new RejectError('Missing upload');
        await storage.download(req.rawKey, raw);
      }
    } else {
      await storage.download((target as typeof schema.fallbackTracks.$inferSelect).rawKey, raw);
    }

    // validate
    const { size } = await stat(raw);
    const probe = await tools.probe(raw).catch(() => {
      throw new RejectError('File is not readable audio');
    });
    const tags = validateProbe(probe, size, settings);

    // Transcode, artwork and analysis all read the source independently, so they run side by
    // side; wall time is roughly the slowest step instead of the sum of all of them.
    const storageKey = `cooked/${job.kind}/${job.id}.mp3`;
    const artKey = `art/${job.kind}/${job.id}.jpg`;
    const [digest, analysis, artworkUrl, fingerprint] = await Promise.all([
      sha256(raw),
      // The analysis runs on the cooked file, so every position refers to what listeners play.
      tools
        .transcode(raw, cooked)
        .then(() =>
          Promise.all([
            storage.upload(storageKey, cooked, 'audio/mpeg'),
            analyzeCooked(cooked, tools, settings.lufsTarget),
          ]),
        )
        .then(([, a]) => a),
      tools
        .extractArtwork(raw, art)
        .then(async (ok) =>
          ok ? (await storage.upload(artKey, art, 'image/jpeg'), storage.publicUrl(artKey)) : null,
        ),
      tools.fingerprint(raw),
    ]);

    const blockedBy =
      job.kind === 'request'
        ? (await db.select().from(schema.dmcaBlocklist)).find(
            (b) => fingerprintSimilarity(fingerprint, b.fingerprint) >= FINGERPRINT_MATCH_THRESHOLD,
          )
        : undefined;

    // finalize
    const common = { ...analysis, fingerprint, sha256: digest, storageKey, analyzedAt: new Date() };
    if (job.kind === 'fallback') {
      const t = target as typeof schema.fallbackTracks.$inferSelect;
      await db
        .update(schema.fallbackTracks)
        .set({
          ...common,
          title: tags.title || t.title || titleFromFilename(t.rawKey),
          artist: tags.artist || t.artist,
          status: 'ready',
          error: null,
        })
        .where(eq(schema.fallbackTracks.id, job.id));
      await deps.publish({ type: 'fallback.ready', trackId: job.id });
    } else {
      const r = target as typeof schema.requests.$inferSelect;
      const hit = blockedBy;
      await db
        .update(schema.requests)
        .set({
          ...common,
          title: r.title || tags.title || titleFromFilename(r.rawUrl ?? r.rawKey ?? ''),
          artist: r.artist || tags.artist,
          artworkUrl: r.artworkUrl ?? artworkUrl,
          status: hit ? 'rejected' : 'ready',
          rejectReason: hit ? 'This recording is blocked following a copyright notice.' : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.requests.id, job.id));
      await deps.publish({ type: 'request.status', requestId: r.id, userId: r.userId });
    }
    deps.log.info(
      {
        ...job,
        lufs: analysis.lufs,
        gainDb: analysis.gainDb,
        crossfadeMs: analysis.crossfadeDurationMs,
      },
      'media ready',
    );

    // The models take minutes on the CPU-only server, so the track goes live first (its DSP
    // analysis is enough for a plain crossfade) and the transition planner uses the model analysis
    // once it lands. Only a track picked within those minutes misses the AI mix.
    if (!blockedBy)
      await addModelAnalysis(job.kind, job.id, cooked, deps).catch((err: Error) =>
        deps.log.info({ ...job, err: err.message }, 'model analysis failed'),
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function markFailed(
  job: MediaJob,
  reason: string,
  deps: Pick<PipelineDeps, 'db' | 'publish'>,
) {
  if (job.kind === 'fallback') {
    await deps.db
      .update(schema.fallbackTracks)
      .set({ status: 'failed', error: reason })
      .where(eq(schema.fallbackTracks.id, job.id));
    return;
  }
  const [row] = await deps.db
    .update(schema.requests)
    .set({ status: 'rejected', rejectReason: reason, updatedAt: new Date() })
    .where(eq(schema.requests.id, job.id))
    .returning({ id: schema.requests.id, userId: schema.requests.userId });
  if (row) await deps.publish({ type: 'request.status', requestId: row.id, userId: row.userId });
}
