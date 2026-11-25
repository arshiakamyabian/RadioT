import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AiAnalysis,
  StationSettings,
  TrackFeatures,
  TransitionClip,
  TransitionMetricsRecord,
  TransitionPlan,
} from '@radiot/shared';
import { users } from './auth.js';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const userRef = (name = 'user_id') =>
  text(name)
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

export const roleEnum = pgEnum('role', ['user', 'admin']);

export const profiles = pgTable('profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  handle: text('handle').unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  locale: text('locale').notNull().default('en'),
  role: roleEnum('role').notNull().default('user'),
  badges: jsonb('badges').$type<string[]>().notNull().default([]),
  ageConfirmedAdult: boolean('age_confirmed_adult').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// Singleton row (id = 1). Values are validated by stationSettingsSchema on read and write.
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  value: jsonb('value').$type<StationSettings>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// Columns the worker computes for every playable track; the API ships them to the players.
const analysis = () => ({
  durationMs: integer('duration_ms'),
  lufs: real('lufs'),
  truePeak: real('true_peak'),
  gainDb: real('gain_db'),
  cueInMs: integer('cue_in_ms'),
  cueOutMs: integer('cue_out_ms'),
  crossfadeStartMs: integer('crossfade_start_ms'),
  crossfadeDurationMs: integer('crossfade_duration_ms'),
  fingerprint: jsonb('fingerprint').$type<number[]>(),
  sha256: text('sha256'),
  storageKey: text('storage_key'),
  analyzedAt: ts('analyzed_at'),
  // Deep analysis for the transition planner (tempo, beat grid, key, intro/outro, curves).
  features: jsonb('features').$type<TrackFeatures>(),
  // Pretrained-model analysis (beats, structure, stem levels; stems live in storage). Computed
  // only where the ML service is installed (ML_PYTHON); null elsewhere.
  ai: jsonb('ai').$type<AiAnalysis>(),
});

export const fallbackTracks = pgTable(
  'fallback_tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    artist: text('artist').notNull().default(''),
    rawKey: text('raw_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status', { enum: ['ingesting', 'ready', 'failed'] })
      .notNull()
      .default('ingesting'),
    error: text('error'),
    playCount: integer('play_count').notNull().default(0),
    lastPlayedAt: ts('last_played_at'),
    createdAt: createdAt(),
    ...analysis(),
  },
  (t) => [uniqueIndex('fallback_tracks_raw_key_idx').on(t.rawKey)],
);

export const requestStatusEnum = pgEnum('request_status', [
  'pending_upload',
  'ingesting',
  'ready',
  'queued',
  'playing',
  'played',
  'rejected',
  'expired',
]);

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    source: text('source', { enum: ['upload', 'url'] }).notNull(),
    rawUrl: text('raw_url'),
    rawKey: text('raw_key'),
    title: text('title').notNull().default(''),
    artist: text('artist').notNull().default(''),
    artworkUrl: text('artwork_url'),
    status: requestStatusEnum('status').notNull().default('pending_upload'),
    rejectReason: text('reject_reason'),
    roundsWaited: integer('rounds_waited').notNull().default(0),
    termsAcceptedAt: ts('terms_accepted_at').notNull(),
    ipHash: text('ip_hash').notNull(),
    playedAt: ts('played_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    ...analysis(),
  },
  (t) => [
    index('requests_status_idx').on(t.status, t.createdAt),
    index('requests_user_idx').on(t.userId, t.createdAt),
  ],
);

// A rendered transition clip for one ordered pair of tracks under one plan. Pairs recur in the
// rotation, so clips are cached: `planHash` changes when the plan (settings or analysis) does.
// `fromId` / `toId` are ids of requests or fallback tracks.
export const transitions = pgTable(
  'transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromId: uuid('from_id').notNull(),
    toId: uuid('to_id').notNull(),
    planHash: text('plan_hash').notNull(),
    plan: jsonb('plan').$type<TransitionPlan>().notNull(),
    status: text('status', { enum: ['rendering', 'ready', 'failed'] })
      .notNull()
      .default('rendering'),
    error: text('error'),
    clipKey: text('clip_key'),
    clip: jsonb('clip').$type<TransitionClip>(),
    metrics: jsonb('metrics').$type<TransitionMetricsRecord>(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('transitions_pair_idx').on(t.fromId, t.toId, t.planHash)],
);

export const rounds = pgTable(
  'rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
    fallbackTrackId: uuid('fallback_track_id').references(() => fallbackTracks.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull().default(''),
    artist: text('artist').notNull().default(''),
    durationMs: integer('duration_ms').notNull(),
    status: text('status', { enum: ['open', 'locked', 'closed'] })
      .notNull()
      .default('open'),
    startedAt: ts('started_at').notNull(),
    lockAt: ts('lock_at').notNull(),
    lockedAt: ts('locked_at'),
    endedAt: ts('ended_at'),
    winnerRequestId: uuid('winner_request_id').references(() => requests.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('rounds_started_idx').on(t.startedAt)],
);

export const votes = pgTable(
  'votes',
  {
    roundId: uuid('round_id')
      .notNull()
      .references(() => rounds.id, { onDelete: 'cascade' }),
    userId: userRef(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    ipHash: text('ip_hash').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roundId, t.userId] }),
    index('votes_round_request_idx').on(t.roundId, t.requestId),
  ],
);

// Multi-account heuristic output: several accounts from one IP voting identically in a round.
export const voteFlags = pgTable('vote_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  roundId: uuid('round_id')
    .notNull()
    .references(() => rounds.id, { onDelete: 'cascade' }),
  requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
  ipHash: text('ip_hash').notNull(),
  userIds: jsonb('user_ids').$type<string[]>().notNull(),
  reviewedAt: ts('reviewed_at'),
  createdAt: createdAt(),
});

export const reactions = pgTable('reactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userRef(),
  emoji: text('emoji').notNull(),
  createdAt: createdAt(),
});

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    body: text('body').notNull(),
    deletedAt: ts('deleted_at'),
    deletedBy: text('deleted_by'),
    createdAt: createdAt(),
  },
  (t) => [index('chat_created_idx').on(t.createdAt)],
);

// Bans and mutes, keyed by user and/or IP hash. A null expiresAt is permanent.
export const sanctions = pgTable(
  'sanctions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: ['ban', 'mute'] }).notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    ipHash: text('ip_hash'),
    reason: text('reason').notNull().default(''),
    expiresAt: ts('expires_at'),
    liftedAt: ts('lifted_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('sanctions_user_idx').on(t.userId),
    index('sanctions_ip_idx').on(t.ipHash),
    check('sanctions_target_chk', sql`${t.userId} is not null or ${t.ipHash} is not null`),
  ],
);

export const liveSessions = pgTable('live_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userRef(),
  requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
  roundId: uuid('round_id').references(() => rounds.id, { onDelete: 'set null' }),
  livekitRoom: text('livekit_room').notNull(),
  identity: text('identity').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  endReason: text('end_reason'),
});

export const micViolations = pgTable('mic_violations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  liveSessionId: uuid('live_session_id').references(() => liveSessions.id, {
    onDelete: 'set null',
  }),
  requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterId: userRef('reporter_id'),
  targetUserId: text('target_user_id').references(() => users.id, { onDelete: 'cascade' }),
  targetKind: text('target_kind', { enum: ['chat', 'stage', 'request', 'profile'] }).notNull(),
  targetId: text('target_id').notNull(),
  reason: text('reason').notNull(),
  resolvedAt: ts('resolved_at'),
  resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const adminActions = pgTable(
  'admin_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: text('admin_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('admin_actions_created_idx').on(t.createdAt)],
);

export const dmcaBlocklist = pgTable('dmca_blocklist', {
  id: uuid('id').primaryKey().defaultRandom(),
  fingerprint: jsonb('fingerprint').$type<number[]>().notNull(),
  title: text('title').notNull().default(''),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userRef(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: createdAt(),
});
