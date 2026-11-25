import { and, eq, gt, inArray, isNull, or, schema, sql, type Database } from '@radiot/db';
import type { PublicUser } from '@radiot/shared';

export async function publicUsers(db: Database, ids: string[]): Promise<Map<string, PublicUser>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      image: schema.users.image,
      handle: schema.profiles.handle,
      displayName: schema.profiles.displayName,
      avatarUrl: schema.profiles.avatarUrl,
    })
    .from(schema.users)
    .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.users.id))
    .where(inArray(schema.users.id, unique));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.displayName || r.name || (r.handle ? `@${r.handle}` : 'Listener'),
        handle: r.handle,
        avatarUrl: r.avatarUrl ?? r.image,
      },
    ]),
  );
}

export const UNKNOWN_USER = (id: string): PublicUser => ({
  id,
  name: 'Listener',
  handle: null,
  avatarUrl: null,
});

export async function getRole(db: Database, userId: string) {
  const p = await db.query.profiles.findFirst({
    where: eq(schema.profiles.userId, userId),
    columns: { role: true },
  });
  return p?.role ?? 'user';
}

/** Active ban/mute for a user or IP hash. */
export async function activeSanction(
  db: Database,
  kind: 'ban' | 'mute',
  userId: string | null,
  ipHash: string | null,
) {
  const targets = [
    userId ? eq(schema.sanctions.userId, userId) : undefined,
    ipHash ? eq(schema.sanctions.ipHash, ipHash) : undefined,
  ].filter((x): x is NonNullable<typeof x> => Boolean(x));
  if (!targets.length) return null;
  return (
    (await db.query.sanctions.findFirst({
      where: and(
        eq(schema.sanctions.kind, kind),
        isNull(schema.sanctions.liftedAt),
        or(isNull(schema.sanctions.expiresAt), gt(schema.sanctions.expiresAt, sql`now()`)),
        or(...targets),
      ),
    })) ?? null
  );
}
