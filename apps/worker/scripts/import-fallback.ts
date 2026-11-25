// Ingests content/fallback/* through the media pipeline (validate, transcode, analyze) using the
// local ffmpeg/fpcalc, and uploads the results to the Blob store the station plays from.
// Re-running is safe: files already imported (same name) are skipped unless --force.
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { eq, schema } from '@radiot/db';
import { createDeps } from '../src/deps.js';
import { runMediaJob } from '../src/jobs.js';

const AUDIO = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav']);
const dir = resolve(
  process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) ??
    '../../content/fallback',
);
const force = process.argv.includes('--force');

const { deps, pool } = createDeps();
const { db, storage } = deps;

const files = (await readdir(dir)).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort();
let imported = 0;
for (const file of files) {
  const rawKey = `raw/fallback/${file}`;
  const existing = await db.query.fallbackTracks.findFirst({
    where: eq(schema.fallbackTracks.rawKey, rawKey),
  });
  if (existing && !force && existing.status !== 'failed') {
    console.log(`skip ${file} (${existing.status})`);
    continue;
  }
  await storage.upload(rawKey, join(dir, file), 'application/octet-stream');
  const [row] = existing
    ? await db
        .update(schema.fallbackTracks)
        .set({ status: 'ingesting', error: null })
        .where(eq(schema.fallbackTracks.id, existing.id))
        .returning()
    : await db.insert(schema.fallbackTracks).values({ rawKey, title: '' }).returning();
  await runMediaJob({ kind: 'fallback', id: row!.id }, deps);
  const done = await db.query.fallbackTracks.findFirst({
    where: eq(schema.fallbackTracks.id, row!.id),
  });
  console.log(
    `${done?.status === 'ready' ? 'ready' : 'FAILED'} ${file}${done?.error ? `: ${done.error}` : ''}`,
  );
  if (done?.status === 'ready') imported++;
}
console.log(`${imported} imported, ${files.length - imported} skipped or failed.`);
await pool.end();
