// Runs the pretrained-model analysis (apps/worker/ml) for every cooked track that doesn't have it
// yet, one song at a time, and stores the result in the `ai` column (stems go to storage).
// Needs ML_PYTHON in apps/worker/.env (e.g. ml/.venv/bin/python). Usage: pnpm ml:backfill [--force]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNotNull, isNull, schema } from '@radiot/db';
import { createDeps } from '../src/deps.js';
import { analyzeWithModels } from '../src/media/ml.js';

const force = process.argv.includes('--force');
const { deps, pool } = createDeps();
const { db, storage } = deps;
if (!deps.ml?.python) {
  console.error('ML_PYTHON is not set (see docs/ml-models.md)');
  process.exit(1);
}

const tables = [
  ['fallback', schema.fallbackTracks],
  ['request', schema.requests],
] as const;
for (const [kind, table] of tables) {
  const rows = await db
    .select({ id: table.id, title: table.title, storageKey: table.storageKey })
    .from(table)
    .where(
      force ? isNotNull(table.storageKey) : and(isNotNull(table.storageKey), isNull(table.ai)),
    );
  for (const row of rows) {
    const dir = await mkdtemp(join(tmpdir(), 'radiot-backfill-'));
    const t0 = Date.now();
    try {
      const cooked = join(dir, 'cooked.mp3');
      await storage.download(row.storageKey!, cooked);
      const ai = await analyzeWithModels(deps.ml, storage, cooked, `stems/${kind}/${row.id}/`);
      if (ai) await db.update(table).set({ ai }).where(eq(table.id, row.id));
      console.log(
        `${kind} ${row.title}: bpm ${ai?.bpm} sections ${ai?.segments.map((s) => s.label).join(' ')} [${Math.round((Date.now() - t0) / 1000)} s]`,
      );
    } catch (err) {
      console.error(`${kind} ${row.title}: ${(err as Error).message.slice(0, 300)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
await pool.end();
