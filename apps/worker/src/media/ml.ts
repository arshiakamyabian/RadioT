import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiAnalysisSchema, type AiAnalysis } from '@radiot/shared';
import { runOk } from './exec.js';
import { decodePcm } from './pcm.js';
import { MIXED_STEMS, RENDER_RATE, type DecodeStems, type MixedStem } from './render.js';
import type { Storage } from '../storage.js';

const SCRIPT = fileURLToPath(new URL('../../ml/analyze.py', import.meta.url));

export interface MlConfig {
  /** Python of the ML environment (apps/worker/ml/.venv/bin/python); unset = ML off. */
  python?: string;
  device?: string;
  /** Demucs model: `htdemucs` (~4x faster on CPU) or `htdemucs_ft` (the analyze.py default). */
  stemModel?: string;
  ffmpeg: string;
}

/** Separated parts: B's overlap (<= 32 s) plus lead-out fit in the head, A's exit search in the tail. */
const ML_HEAD_SEC = 45;
const ML_TAIL_SEC = 55;

// One song at a time: the models need most of a small machine's memory.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Runs the pretrained models on a cooked file, uploads its stems (FLAC) under
 * `stems/<kind>/<id>/` and returns the analysis to store in the track's `ai` column.
 */
export function analyzeWithModels(
  cfg: MlConfig,
  storage: Storage,
  cooked: string,
  prefix: string,
): Promise<AiAnalysis | null> {
  if (!cfg.python) return Promise.resolve(null);
  return serial(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'radiot-ml-'));
    try {
      const out = join(dir, 'ai.json');
      const stemsDir = join(dir, 'stems');
      await runOk(
        cfg.python!,
        [
          SCRIPT,
          cooked,
          '--out',
          out,
          '--stems-dir',
          stemsDir,
          '--device',
          cfg.device ?? 'auto',
          ...(cfg.stemModel ? ['--stem-model', cfg.stemModel] : []),
          // Only the opening and the last minute are mixed, so only they are separated.
          '--head-sec',
          String(ML_HEAD_SEC),
          '--tail-sec',
          String(ML_TAIL_SEC),
        ],
        // Uploads wait for this before they can be voted on, so a hung run must not hold one for
        // long (and the API re-dispatches requests still ingesting after 15 minutes).
        { env: { ...process.env, FFMPEG_PATH: cfg.ffmpeg }, timeoutMs: 10 * 60_000 },
      );
      const ai = aiAnalysisSchema.parse(JSON.parse(await readFile(out, 'utf8')));
      for (const file of Object.values(ai.stemFiles)) {
        await storage.upload(`${prefix}${file}`, join(stemsDir, file), 'audio/flac');
      }
      return { ...ai, stemPrefix: prefix };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** Downloads a track's stems into `dir` and returns a decoder for the renderer. */
export async function stemDecoder(
  storage: Storage,
  ai: AiAnalysis,
  dir: string,
  ffmpeg: string,
): Promise<DecodeStems | null> {
  if (!ai.stemPrefix) return null;
  await mkdir(dir, { recursive: true });
  const files = {} as Record<MixedStem, string>;
  for (const stem of MIXED_STEMS) {
    const name = ai.stemFiles[stem];
    if (!name) return null;
    files[stem] = join(dir, `${stem}.flac`);
    await storage.download(`${ai.stemPrefix}${name}`, files[stem]);
  }
  return localStemDecoder(files, ffmpeg);
}

export function localStemDecoder(files: Record<MixedStem, string>, ffmpeg: string): DecodeStems {
  return async (fromSec, durationSec) => {
    const out = {} as Awaited<ReturnType<DecodeStems>>;
    for (const stem of MIXED_STEMS) {
      out[stem] = await decodePcm(ffmpeg, files[stem], RENDER_RATE, { fromSec, durationSec });
    }
    return out;
  };
}
