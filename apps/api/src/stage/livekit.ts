import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  TrackType,
  WebhookReceiver,
  type VideoGrant,
  type WebhookEvent,
} from 'livekit-server-sdk';
import { STAGE_ROOM } from '@radiot/shared';

/**
 * Mic enforcement, layer 2: the performer grant can only ever publish a camera track, and
 * cannot publish data. (Layer 1 is the client's getUserMedia; layer 3 is handleStageEvent.)
 */
export function performerGrant(): VideoGrant {
  return {
    roomJoin: true,
    room: STAGE_ROOM,
    canPublish: true,
    canPublishSources: [TrackSource.CAMERA],
    canPublishData: false,
    canSubscribe: true,
    canUpdateOwnMetadata: false,
  };
}

export function viewerGrant(): VideoGrant {
  return {
    roomJoin: true,
    room: STAGE_ROOM,
    canPublish: false,
    canPublishData: false,
    canSubscribe: true,
  };
}

export async function mintToken(
  apiKey: string,
  apiSecret: string,
  identity: string,
  name: string,
  grant: VideoGrant,
  ttlSeconds: number,
) {
  const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: ttlSeconds });
  at.addGrant(grant);
  return at.toJwt();
}

export interface StageEventDeps {
  isPerformer(
    identity: string,
  ): Promise<{ sessionId: string; userId: string; requestId: string | null } | null>;
  removeParticipant(room: string, identity: string): Promise<void>;
  recordViolation(v: {
    userId: string;
    sessionId: string;
    requestId: string | null;
    detail: Record<string, unknown>;
  }): Promise<void>;
  endSession(sessionId: string, reason: string): Promise<void>;
  goLive(sessionId: string): Promise<void>;
}

/**
 * Mic enforcement, layer 3: any audio (or non-camera) track published by a performer is a
 * violation. The participant is removed immediately, the session ends and a row is recorded.
 */
export async function handleStageEvent(
  event: WebhookEvent,
  deps: StageEventDeps,
): Promise<'violation' | 'live' | 'ended' | 'ignored'> {
  const identity = event.participant?.identity;
  const room = event.room?.name ?? STAGE_ROOM;
  if (!identity) return 'ignored';

  if (event.event === 'track_published' && event.track) {
    const performer = await deps.isPerformer(identity);
    const isAudio = event.track.type === TrackType.AUDIO;
    const isCamera =
      event.track.source === TrackSource.CAMERA && event.track.type === TrackType.VIDEO;
    if (isAudio || !isCamera) {
      // Audio is never acceptable on stage, from anyone, so kick even unknown identities.
      await deps.removeParticipant(room, identity);
      if (performer) {
        await deps.recordViolation({
          userId: performer.userId,
          sessionId: performer.sessionId,
          requestId: performer.requestId,
          detail: {
            trackSid: event.track.sid,
            type: event.track.type,
            source: event.track.source,
            mimeType: event.track.mimeType,
          },
        });
        await deps.endSession(performer.sessionId, isAudio ? 'mic_violation' : 'non_camera_track');
      }
      return 'violation';
    }
    if (performer) {
      await deps.goLive(performer.sessionId);
      return 'live';
    }
    return 'ignored';
  }

  if (event.event === 'participant_left') {
    const performer = await deps.isPerformer(identity);
    if (performer) {
      await deps.endSession(performer.sessionId, 'left');
      return 'ended';
    }
  }
  return 'ignored';
}

export function createLiveKit(host: string, apiKey: string, apiSecret: string) {
  return {
    url: host,
    apiKey,
    apiSecret,
    rooms: new RoomServiceClient(host.replace(/^ws/, 'http'), apiKey, apiSecret),
    receiver: new WebhookReceiver(apiKey, apiSecret),
  };
}
export type LiveKit = ReturnType<typeof createLiveKit>;
