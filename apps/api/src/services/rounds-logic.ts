export interface CandidateLike {
  id: string;
  createdAt: Date;
}

/** Most votes wins; ties go to the request that has waited longest. No votes still picks the oldest. */
export function pickWinner<T extends CandidateLike>(
  candidates: T[],
  counts: Map<string, number>,
): T | null {
  if (!candidates.length) return null;
  return [...candidates].sort(
    (a, b) =>
      (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  )[0]!;
}

/**
 * One vote covers new uploads and rotation songs. Most votes wins (ties: new uploads first, then
 * rotation order). With no votes at all, the oldest new upload wins; null leaves it to the rotation.
 */
export function pickRoundWinner<T extends CandidateLike>(
  fresh: T[],
  rotation: T[],
  counts: Map<string, number>,
): { winner: T; fromRotation: boolean } | null {
  const ordered = [
    ...[...fresh].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    ...rotation,
  ];
  const best = Math.max(0, ...ordered.map((c) => counts.get(c.id) ?? 0));
  const winner =
    best > 0 ? ordered.find((c) => (counts.get(c.id) ?? 0) === best) : pickWinner(fresh, counts);
  return winner ? { winner, fromRotation: !fresh.includes(winner) } : null;
}

/**
 * Voting closes `lockLeadSeconds` before the transition so the winner can prebuffer, but never
 * takes more than 20% of a song: short tracks still leave most of their airtime for voting.
 */
export function computeLockAt(
  startedAt: Date,
  airtime: number,
  lockLeadSeconds: number,
  minLeadMs = 5000,
) {
  const lead = Math.min(lockLeadSeconds * 1000, airtime * 0.2);
  const lock = startedAt.getTime() + airtime - lead;
  return new Date(Math.max(lock, startedAt.getTime() + minLeadMs));
}

/** Requests that should expire after this round, given they were not picked. */
export function expiringAfterRound<T extends { id: string; roundsWaited: number }>(
  losers: T[],
  expiryCount: number,
) {
  return losers.filter((r) => r.roundsWaited + 1 >= expiryCount);
}

/** Multi-account heuristic: ≥2 accounts on one IP hash voting for the same request in a round. */
export function detectVoteFlags(votes: { userId: string; requestId: string; ipHash: string }[]) {
  const groups = new Map<string, Set<string>>();
  for (const v of votes) {
    const key = `${v.ipHash}|${v.requestId}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(v.userId);
  }
  return [...groups.entries()]
    .filter(([, users]) => users.size > 1)
    .map(([key, users]) => {
      const [ipHash, requestId] = key.split('|') as [string, string];
      return { ipHash, requestId, userIds: [...users].sort() };
    });
}
