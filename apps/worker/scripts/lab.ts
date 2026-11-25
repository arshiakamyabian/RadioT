// Transition lab: runs the analysis and the transition renderer on local files, no database or
// Blob needed. Usage (from apps/worker): tsx scripts/lab.ts <command> [dir]
//   analyze   decode every .tmp/lab/cooked/*.mp3 and write .tmp/lab/analysis/<name>.json
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PLAN_OPTIONS,
  aiAnalysisSchema,
  keyName,
  vocalOverlapSeconds,
  type AiAnalysis,
  pairCompatibility,
  planTransition,
  simplePlan,
  trackAnalysisSchema,
  type PlanOptions,
  type TrackAnalysis,
  type TransitionPlan,
} from '@radiot/shared';
import { computeGain, parseEbur128 } from '../src/media/analysis.js';
import { runOk } from '../src/media/exec.js';
import { ANALYSIS_RATE, analyzeTrack } from '../src/media/features.js';
import { localStemDecoder } from '../src/media/ml.js';
import { decodePcm } from '../src/media/pcm.js';
import {
  RENDER_RATE,
  renderTransition,
  STEM_RENDER_OPTIONS,
  type Decode,
  type TransitionMetrics,
} from '../src/media/render.js';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const LAB = resolve(process.env.LAB_DIR ?? '../../.tmp/lab');
const TARGET_LUFS = -14;

export interface LabTrack {
  name: string;
  file: string;
  analysis: TrackAnalysis;
  /** apps/worker/ml/analyze.py output (.tmp/lab/ai/<name>.json), with stems next to it. */
  ai: AiAnalysis | null;
}

async function loadAi(name: string): Promise<AiAnalysis | null> {
  try {
    return aiAnalysisSchema.parse(
      JSON.parse(await readFile(join(LAB, 'ai', `${name}.json`), 'utf8')),
    );
  } catch {
    return null;
  }
}

export async function loadTracks(): Promise<LabTrack[]> {
  const dir = join(LAB, 'analysis');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (f) => {
      const name = f.replace(/\.json$/, '');
      return {
        name,
        file: join(LAB, 'cooked', `${name}.mp3`),
        analysis: trackAnalysisSchema.parse(JSON.parse(await readFile(join(dir, f), 'utf8'))),
        ai: await loadAi(name),
      };
    }),
  );
}

async function analyze() {
  await mkdir(join(LAB, 'analysis'), { recursive: true });
  const files = (await readdir(join(LAB, 'cooked'))).filter((f) => f.endsWith('.mp3')).sort();
  const only = process.argv[3];
  for (const f of files) {
    if (only && !f.includes(only)) continue;
    const file = join(LAB, 'cooked', f);
    const t0 = Date.now();
    const { stderr } = await runOk(FFMPEG, [
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      'ebur128=peak=true',
      '-f',
      'null',
      '-',
    ]);
    const loud = parseEbur128(stderr);
    const pcm = await decodePcm(FFMPEG, file, ANALYSIS_RATE);
    const t1 = Date.now();
    const deep = analyzeTrack({ left: pcm.channels[0], right: pcm.channels[1] });
    const analysis: TrackAnalysis = trackAnalysisSchema.parse({
      durationMs: deep.durationMs,
      lufs: loud.lufs,
      truePeak: loud.truePeak,
      gainDb: computeGain(loud.lufs, loud.truePeak, TARGET_LUFS),
      cueInMs: deep.cueInMs,
      cueOutMs: deep.cueOutMs,
      crossfadeStartMs: Math.max(deep.cueInMs, deep.features.outro.fadeStartMs),
      crossfadeDurationMs: Math.min(
        12_000,
        Math.max(2_000, deep.cueOutMs - deep.features.outro.fadeStartMs),
      ),
      features: deep.features,
    });
    await writeFile(join(LAB, 'analysis', f.replace(/\.mp3$/, '.json')), JSON.stringify(analysis));
    const x = deep.features;
    const sec = (ms: number | null) => (ms === null ? '  -  ' : (ms / 1000).toFixed(1).padStart(5));
    console.log(
      [
        f
          .replace(/\.mp3$/, '')
          .slice(0, 26)
          .padEnd(26),
        `${(deep.durationMs / 1000).toFixed(0).padStart(3)}s`,
        `I ${loud.lufs.toFixed(1)} (own ${deep.lufs.toFixed(1)}) TP ${loud.truePeak.toFixed(1)}`,
        `bpm ${x.bpm?.toFixed(2) ?? '-'} str ${x.grid?.strength ?? '-'}/${x.headGrid?.strength ?? '-'}/${x.tailGrid?.strength ?? '-'}`,
        `db ${x.downbeatConfidence}`,
        `key ${x.key ? `${keyName(x.key.tonic, x.key.mode)} ${x.key.camelot} ${x.key.confidence}` : '-'}`,
        `E ${x.energy}`,
        `cue ${sec(deep.cueInMs)}-${sec(deep.cueOutMs)}`,
        `in ${x.intro.type}@${sec(x.intro.endMs)}`,
        `out ${x.outro.type}@${sec(x.outro.startMs)} fade ${sec(x.outro.fadeStartMs)} drop ${sec(x.outro.dropMs)}`,
        `beat ${sec(x.beatStartMs)}-${sec(x.beatEndMs)}`,
        `voc ${sec(x.vocalInMs)}-${sec(x.vocalOutMs)}`,
        `[decode ${t1 - t0}ms, analyze ${Date.now() - t1}ms]`,
      ].join(' | '),
    );
  }
}

const flag = (name: string) => process.argv.includes(`--${name}`);
const round2 = (x: number) => Math.round(x * 100) / 100;

function decoder(file: string): Decode {
  return (fromSec, durationSec) => decodePcm(FFMPEG, file, RENDER_RATE, { fromSec, durationSec });
}

async function writeMp3(file: string, channels: Float32Array[], sampleRate: number) {
  const n = channels[0]!.length;
  const inter = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    inter[2 * i] = channels[0]![i]!;
    inter[2 * i + 1] = channels[1]![i]!;
  }
  const raw = `${file}.f32`;
  await writeFile(raw, Buffer.from(inter.buffer));
  await runOk(FFMPEG, [
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-f',
    'f32le',
    '-ar',
    String(sampleRate),
    '-ac',
    '2',
    '-i',
    raw,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '256k',
    file,
  ]);
  await rm(raw);
}

/** The gain rule the station used before (peak-capped even for cuts), for the audit renders. */
function legacyGain(t: TrackAnalysis) {
  return Math.round(Math.min(TARGET_LUFS - t.lufs, -1.5 - t.truePeak) * 100) / 100;
}

export async function renderPair(
  a: LabTrack,
  b: LabTrack,
  legacy: boolean,
  opts: Partial<PlanOptions> = {},
) {
  const plan = legacy
    ? simplePlan(a.analysis, b.analysis, DEFAULT_PLAN_OPTIONS, 'legacy crossfade')
    : planTransition(a.analysis, b.analysis, opts);
  const out = await renderTransition(
    decoder(a.file),
    decoder(b.file),
    { ...a.analysis, gainDb: legacy ? legacyGain(a.analysis) : a.analysis.gainDb },
    { ...b.analysis, gainDb: legacy ? legacyGain(b.analysis) : b.analysis.gainDb },
    plan,
    legacy ? { leveler: false, ceilingDb: null } : {},
  );
  return { plan, out };
}

function describe(a: LabTrack, b: LabTrack, plan: TransitionPlan, m: TransitionMetrics) {
  const c = pairCompatibility(a.analysis, b.analysis, 6);
  const beat = m.beatErrorMs
    ? `beat err ${m.beatErrorMs.median}/${m.beatErrorMs.p90}ms (${m.beatErrorMs.beats})`
    : 'no sync';
  return [
    `${a.name.slice(0, 18)} -> ${b.name.slice(0, 18)}`.padEnd(41),
    plan.style.padEnd(9),
    `${(plan.overlapMs / 1000).toFixed(1)}s`.padStart(6),
    `tempo ${c.tempoRatio ? ((c.tempoRatio - 1) * 100).toFixed(1) + '%' : '-'} key ${c.key}`,
    `TP ${m.truePeakDb}`,
    `loud ${m.beforeLufs}>${m.afterLufs} exc ${m.loudnessExcursionLu} LU`,
    `quiet ${m.quietestDb} dB`,
    beat,
    `lim ${m.limiterReductionDb} lvl ${m.levelerRangeDb.join('..')}`,
  ].join(' | ');
}

async function plans() {
  const tracks = await loadTracks();
  const counts: Record<string, number> = {};
  for (const a of tracks) {
    for (const b of tracks) {
      if (a === b) continue;
      const plan = planTransition(a.analysis, b.analysis);
      counts[plan.style + (plan.sync ? '+sync' : '')] =
        (counts[plan.style + (plan.sync ? '+sync' : '')] ?? 0) + 1;
      if (flag('all') || (process.argv[3] && a.name.includes(process.argv[3]))) {
        console.log(
          `${a.name.slice(0, 16)} -> ${b.name.slice(0, 16)}`.padEnd(36),
          plan.style.padEnd(9),
          (plan.sync ? `sync ${plan.sync.beats}b` : '').padEnd(9),
          `${(plan.overlapMs / 1000).toFixed(1)}s`.padStart(6),
          `A ${(plan.aStartMs / 1000).toFixed(1)}-${(plan.aEndMs / 1000).toFixed(1)} B ${(plan.bStartMs / 1000).toFixed(1)}-${(plan.bEndMs / 1000).toFixed(1)}`,
          '|',
          plan.reasons.join('; '),
        );
      }
    }
  }
  console.log(counts);
}

async function render() {
  const tracks = await loadTracks();
  const find = (q: string) => {
    const t = tracks.find((x) => x.name.includes(q));
    if (!t) throw new Error(`no track matching ${q}`);
    return t;
  };
  const a = find(process.argv[3] ?? '');
  const b = find(process.argv[4] ?? '');
  const legacy = flag('legacy');
  const t0 = Date.now();
  const { plan, out } = await renderPair(a, b, legacy);
  await mkdir(join(LAB, 'out'), { recursive: true });
  const file = join(
    LAB,
    'out',
    `${a.name.slice(0, 14)}__${b.name.slice(0, 14)}${legacy ? '.legacy' : ''}.mp3`,
  );
  await writeMp3(file, out.channels, out.sampleRate);
  console.log(describe(a, b, plan, out.metrics));
  console.log(
    plan.reasons.join('; '),
    `| clip ${round2(out.clipMs / 1000)}s lead-in ${out.leadInMs} handoff`,
    out.handoff,
    `[${Date.now() - t0} ms]`,
  );
  console.log(file);
}

const SAMPLE_PAIRS: [string, string][] = [
  ['kid-cudi-can', 'idk-eminem'],
  ['travis', 'joji'],
  ['joji', 'kodak'],
  ['don-toliver', 'dorcci'],
  ['idk-eminem', 'arshia'],
  ['night-lovell', 'percocet'],
  ['percocet', 'don-toliver'],
  ['kendrick', 'percocet'],
  ['arshia', 'night-lovell'],
  ['dorcci', 'idk-eminem'],
  ['kodak', 'night-lovell'],
  ['kid-cudi-can', 'travis'],
];

/** True peak of an encoded file as a listener's decoder will produce it. */
async function filePeak(file: string) {
  const { stderr } = await runOk(FFMPEG, [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]);
  return parseEbur128(stderr).truePeak;
}

/**
 * Renders the sample set twice (the old plain crossfade and the new planner) into
 * docs/transitions/samples and writes the measurements next to them.
 */
async function samples() {
  const tracks = await loadTracks();
  const find = (q: string) => tracks.find((x) => x.name.includes(q))!;
  const dir = resolve('../../docs/transitions/samples');
  await mkdir(join(dir, 'before'), { recursive: true });
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  for (const [qa, qb] of SAMPLE_PAIRS) {
    n++;
    const a = find(qa);
    const b = find(qb);
    const base = `${String(n).padStart(2, '0')}-${a.name.slice(0, 16)}__${b.name.slice(0, 16)}`;
    const next = await renderPair(a, b, false);
    const prev = await renderPair(a, b, true);
    await writeMp3(join(dir, `${base}.mp3`), next.out.channels, next.out.sampleRate);
    await writeMp3(join(dir, 'before', `${base}.mp3`), prev.out.channels, prev.out.sampleRate);
    const peak = await filePeak(join(dir, `${base}.mp3`));
    const peakBefore = await filePeak(join(dir, 'before', `${base}.mp3`));
    const c = pairCompatibility(a.analysis, b.analysis, 6);
    const m = next.out.metrics;
    const checks = {
      noClipping: peak < 0,
      loudness: m.loudnessExcursionLu < 1,
      noGap: m.quietestDb > -45,
      beats: m.beatErrorMs ? m.beatErrorMs.median <= 20 : null,
    };
    rows.push({
      n,
      file: `${base}.mp3`,
      a: a.name,
      b: b.name,
      style: next.plan.style,
      sync: next.plan.sync?.beats ?? null,
      overlapSec: round2(next.plan.overlapMs / 1000),
      reasons: next.plan.reasons,
      tempoDiffPct: c.tempoRatio === null ? null : round2((c.tempoRatio - 1) * 100),
      keyA: a.analysis.features?.key?.camelot ?? null,
      keyB: b.analysis.features?.key?.camelot ?? null,
      keyCompat: c.key,
      filePeakDbtp: peak,
      metrics: m,
      checks,
      before: {
        overlapSec: round2(prev.plan.overlapMs / 1000),
        filePeakDbtp: peakBefore,
        mixPeakDbtp: prev.out.metrics.truePeakDb,
        metrics: prev.out.metrics,
      },
    });
    console.log(describe(a, b, next.plan, m), `| file TP ${peak}`);
    console.log(
      ' '.repeat(10),
      'before:',
      `${round2(prev.plan.overlapMs / 1000)}s`,
      `TP ${prev.out.metrics.truePeakDb}`,
      `exc ${prev.out.metrics.loudnessExcursionLu} LU`,
      `quiet ${prev.out.metrics.quietestDb}`,
    );
  }
  await writeFile(join(dir, 'metrics.json'), JSON.stringify(rows, null, 2));
}

const planTrack = (t: LabTrack, withAi: boolean) => ({ ...t.analysis, ai: withAi ? t.ai : null });

function labStems(t: LabTrack) {
  const dir = join(LAB, 'ai', t.name);
  return localStemDecoder(
    {
      drums: join(dir, 'drums.flac'),
      bass: join(dir, 'bass.flac'),
      vocals: join(dir, 'vocals.flac'),
    },
    FFMPEG,
  );
}

/** AI plans for every pair that has the model analysis (what the planner would do). */
async function aiPlans() {
  const tracks = (await loadTracks()).filter((t) => t.ai);
  const counts: Record<string, number> = {};
  for (const a of tracks) {
    for (const b of tracks) {
      if (a === b) continue;
      const plan = planTransition(planTrack(a, true), planTrack(b, true));
      const key = plan.style + (plan.sync ? '+sync' : '') + (plan.stems ? '+stems' : '');
      counts[key] = (counts[key] ?? 0) + 1;
      if (flag('all') || (process.argv[3] && a.name.includes(process.argv[3]))) {
        console.log(
          `${a.name.slice(0, 16)} -> ${b.name.slice(0, 16)}`.padEnd(36),
          plan.style.padEnd(9),
          `${(plan.overlapMs / 1000).toFixed(1)}s`.padStart(6),
          `voc ${vocalOverlapSeconds(planTrack(a, true), planTrack(b, true), plan)}s`,
          '|',
          plan.reasons.join('; '),
        );
      }
    }
  }
  console.log(counts);
}

const AI_SAMPLE_PAIRS: [string, string][] = [
  ['kid-cudi-can', 'idk-eminem'],
  ['travis', 'kid-cudi-joji'],
  ['kid-cudi-joji', 'kodak'],
  ['don-toliver', 'dorcci'],
  ['idk-eminem', 'arshia'],
  ['night-lovell', 'percocet'],
  ['percocet', 'don-toliver'],
  ['kendrick', 'percocet'],
  ['dorcci', 'idk-eminem'],
  ['kodak', 'night-lovell'],
];

/**
 * Before/after pairs for the AI planner: NN-before.mp3 is today's DSP planner, NN-after.mp3 the
 * AI planner with stems. Both clips are measured (peaks, loudness excursion, silence gaps, beat
 * error, overlapping vocals) into metrics.json.
 */
async function aiSamples() {
  const tracks = await loadTracks();
  const find = (q: string) => {
    const t = tracks.find((x) => x.name.includes(q));
    if (!t?.ai) throw new Error(`no AI analysis for ${q}`);
    return t;
  };
  const dir = resolve('../../docs/transitions/ai-samples');
  await mkdir(dir, { recursive: true });
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  for (const [qa, qb] of AI_SAMPLE_PAIRS) {
    n++;
    const a = find(qa);
    const b = find(qb);
    const nn = String(n).padStart(2, '0');
    const sides = { a: { ...a.analysis }, b: { ...b.analysis } };
    const before = planTransition(planTrack(a, false), planTrack(b, false));
    const after = planTransition(planTrack(a, true), planTrack(b, true));
    const t0 = Date.now();
    const outBefore = await renderTransition(
      decoder(a.file),
      decoder(b.file),
      sides.a,
      sides.b,
      before,
    );
    const t1 = Date.now();
    const outAfter = await renderTransition(
      decoder(a.file),
      decoder(b.file),
      sides.a,
      sides.b,
      after,
      after.stems ? STEM_RENDER_OPTIONS : {},
      after.stems ? { a: labStems(a), b: labStems(b) } : undefined,
    );
    const t2 = Date.now();
    await writeMp3(join(dir, `${nn}-before.mp3`), outBefore.channels, outBefore.sampleRate);
    await writeMp3(join(dir, `${nn}-after.mp3`), outAfter.channels, outAfter.sampleRate);
    const measure = async (file: string, plan: TransitionPlan, m: TransitionMetrics) => {
      const peak = await filePeak(file);
      const vocals = vocalOverlapSeconds(planTrack(a, true), planTrack(b, true), plan);
      return {
        style: plan.style,
        syncBeats: plan.sync?.beats ?? null,
        stems: !!plan.stems,
        overlapSec: round2(plan.overlapMs / 1000),
        mixStartSec: round2(plan.aStartMs / 1000),
        reasons: plan.reasons,
        filePeakDbtp: peak,
        vocalOverlapSec: vocals,
        metrics: m,
        checks: {
          noClipping: peak < 0,
          loudness: m.loudnessExcursionLu < 1,
          noGap: m.quietestDb > -45,
          beats: m.beatErrorMs ? m.beatErrorMs.median <= 20 : null,
          vocalsApart: vocals === null ? null : vocals <= 0.5,
        },
      };
    };
    const row = {
      n,
      a: a.name,
      b: b.name,
      before: await measure(join(dir, `${nn}-before.mp3`), before, outBefore.metrics),
      after: await measure(join(dir, `${nn}-after.mp3`), after, outAfter.metrics),
      renderMs: { before: t1 - t0, after: t2 - t1 },
    };
    rows.push(row);
    const fmt = (r: typeof row.after) =>
      `${r.style}${r.syncBeats ? `/${r.syncBeats}b` : ''} ${r.overlapSec}s TP ${r.filePeakDbtp} exc ${r.metrics.loudnessExcursionLu} quiet ${r.metrics.quietestDb} beat ${r.metrics.beatErrorMs?.median ?? '-'} voc ${r.vocalOverlapSec}s`;
    console.log(`${nn} ${a.name.slice(0, 16)} -> ${b.name.slice(0, 16)}`);
    console.log(`   before: ${fmt(row.before)}`);
    console.log(`   after : ${fmt(row.after)}  [render ${t2 - t1} ms]`);
    console.log(`           ${after.reasons.join('; ')}`);
  }
  await writeFile(join(dir, 'metrics.json'), JSON.stringify(rows, null, 2));
}

/**
 * Stores the lab's model analysis (.tmp/lab/ai) on the matching fallback tracks of the database
 * in DATABASE_URL and copies the stems under LOCAL_MEDIA_DIR/stems, so the local stack plans
 * (and renders) stem-aware transitions. Tracks are matched by file length.
 */
async function attachAi() {
  const { createDb } = await import('@radiot/db');
  const { schema, eq } = await import('@radiot/db');
  const { copyFile, mkdir } = await import('node:fs/promises');
  const url = process.env.DATABASE_URL;
  const media = process.env.LOCAL_MEDIA_DIR
    ? resolve(process.env.LOCAL_MEDIA_DIR)
    : join(LAB, 'media');
  if (!url) throw new Error('DATABASE_URL is not set');
  const { db, pool } = createDb(url);
  const rows = await db.select().from(schema.fallbackTracks);
  for (const t of await loadTracks()) {
    if (!t.ai) continue;
    const row = rows.find(
      (r) => r.durationMs !== null && Math.abs(r.durationMs - t.ai!.durationMs) < 60,
    );
    if (!row) {
      console.log(`${t.name}: no track of that length in the database`);
      continue;
    }
    const prefix = `stems/fallback/${row.id}/`;
    await mkdir(join(media, prefix), { recursive: true });
    for (const file of Object.values(t.ai.stemFiles)) {
      await copyFile(join(LAB, 'ai', t.name, file), join(media, prefix, file));
    }
    await db
      .update(schema.fallbackTracks)
      .set({ ai: { ...t.ai, stemPrefix: prefix } })
      .where(eq(schema.fallbackTracks.id, row.id));
    console.log(`${t.name} -> ${row.title} (${row.id.slice(0, 8)})`);
  }
  await pool.end();
}

const commands: Record<string, () => Promise<void>> = {
  'attach-ai': attachAi,
  analyze,
  plans,
  render,
  samples,
  'ai-plans': aiPlans,
  'ai-samples': aiSamples,
};
const cmd = process.argv[2] ?? '';
if (!commands[cmd]) {
  console.error(`usage: lab.ts <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
await commands[cmd]();
