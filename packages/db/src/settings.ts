import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, stationSettingsSchema, type StationSettings } from '@radiot/shared';
import type { Database } from './client.js';
import { settings } from './schema/index.js';

export async function getSettings(db: Database): Promise<StationSettings> {
  const row = await db.query.settings.findFirst({ where: eq(settings.id, 1) });
  return stationSettingsSchema.parse(row?.value ?? DEFAULT_SETTINGS);
}

export async function upsertSettings(db: Database, patch: Partial<StationSettings>) {
  const next = stationSettingsSchema.parse({ ...(await getSettings(db)), ...patch });
  await db
    .insert(settings)
    .values({ id: 1, value: next })
    .onConflictDoUpdate({ target: settings.id, set: { value: next, updatedAt: new Date() } });
  return next;
}
