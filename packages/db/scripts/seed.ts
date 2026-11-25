import { createDb } from '../src/client.js';
import { upsertSettings } from '../src/settings.js';

const url = process.env.DATABASE_URL ?? 'postgres://radiot:radiot@localhost:5432/radiot';
const { db, pool } = createDb(url);
const value = await upsertSettings(db, {});
await pool.end();
console.log('settings seeded', value);
