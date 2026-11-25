import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/client.js';

const url = process.env.DATABASE_URL ?? 'postgres://radiot:radiot@localhost:5432/radiot';
const { db, pool } = createDb(url);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
await pool.end();
console.log('migrations applied');
