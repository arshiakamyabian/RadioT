// Usage: pnpm admin:grant someone@example.com [--revoke]
import { createDb, eq, schema } from '../src/index.js';

const email = process.argv[2];
const revoke = process.argv.includes('--revoke');
if (!email) {
  console.error('usage: pnpm admin:grant <email> [--revoke]');
  process.exit(1);
}
const { db, pool } = createDb(
  process.env.DATABASE_URL ?? 'postgres://radiot:radiot@localhost:5432/radiot',
);
const user = await db.query.users.findFirst({ where: eq(schema.users.email, email.toLowerCase()) });
if (!user) {
  console.error(`no user with email ${email} (they must sign in once first)`);
  await pool.end();
  process.exit(1);
}
const role = revoke ? 'user' : 'admin';
await db
  .insert(schema.profiles)
  .values({ userId: user.id, role })
  .onConflictDoUpdate({ target: schema.profiles.userId, set: { role } });
await db.insert(schema.adminActions).values({
  adminId: null,
  action: revoke ? 'role.revoke' : 'role.grant',
  target: user.id,
  metadata: { email, via: 'cli' },
});
console.log(`${email} is now ${role}`);
await pool.end();
