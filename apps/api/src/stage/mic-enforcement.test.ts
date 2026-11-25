import { TokenVerifier, TrackSource, TrackType, type WebhookEvent } from 'livekit-server-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  handleStageEvent,
  mintToken,
  performerGrant,
  viewerGrant,
  type StageEventDeps,
} from './livekit.js';

const KEY = 'devkey';
const SECRET = 'devsecret-devsecret-devsecret-devsecret';

function deps(performer = true): StageEventDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    isPerformer: vi.fn(async () =>
      performer ? { sessionId: 's1', userId: 'u1', requestId: 'r1' } : null,
    ),
    removeParticipant: vi.fn(async () => {}),
    recordViolation: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    goLive: vi.fn(async () => {}),
  };
}

const published = (type: TrackType, source: TrackSource) =>
  ({
    event: 'track_published',
    room: { name: 'radiot-stage' },
    participant: { identity: 'u1' },
    track: {
      sid: 'TR_1',
      type,
      source,
      mimeType: type === TrackType.AUDIO ? 'audio/opus' : 'video/vp8',
    },
  }) as unknown as WebhookEvent;

describe('mic enforcement — layer 2: LiveKit grants', () => {
  it('performer tokens can only publish the camera, never data', async () => {
    const jwt = await mintToken(KEY, SECRET, 'u1', 'DJ', performerGrant(), 600);
    const claims = await new TokenVerifier(KEY, SECRET).verify(jwt);
    expect(claims.video?.canPublishSources).toEqual(['camera']);
    expect(claims.video?.canPublishData).toBe(false);
    expect(claims.video?.canPublishSources).not.toContain('microphone');
  });

  it('viewer tokens cannot publish anything', async () => {
    const jwt = await mintToken(KEY, SECRET, 'anon-1', 'Listener', viewerGrant(), 600);
    const claims = await new TokenVerifier(KEY, SECRET).verify(jwt);
    expect(claims.video?.canPublish).toBe(false);
    expect(claims.video?.canPublishData).toBe(false);
    expect(claims.video?.canSubscribe).toBe(true);
  });
});

describe('mic enforcement — layer 3: webhook', () => {
  it('kicks a performer who publishes a microphone track and records the violation', async () => {
    const d = deps();
    expect(await handleStageEvent(published(TrackType.AUDIO, TrackSource.MICROPHONE), d)).toBe(
      'violation',
    );
    expect(d.removeParticipant).toHaveBeenCalledWith('radiot-stage', 'u1');
    expect(d.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        sessionId: 's1',
        detail: expect.objectContaining({ type: TrackType.AUDIO }),
      }),
    );
    expect(d.endSession).toHaveBeenCalledWith('s1', 'mic_violation');
    expect(d.goLive).not.toHaveBeenCalled();
  });

  it('treats audio labelled as a camera source as a violation too', async () => {
    const d = deps();
    expect(await handleStageEvent(published(TrackType.AUDIO, TrackSource.CAMERA), d)).toBe(
      'violation',
    );
    expect(d.endSession).toHaveBeenCalledWith('s1', 'mic_violation');
  });

  it('rejects screen share (non-camera video)', async () => {
    const d = deps();
    expect(await handleStageEvent(published(TrackType.VIDEO, TrackSource.SCREEN_SHARE), d)).toBe(
      'violation',
    );
    expect(d.endSession).toHaveBeenCalledWith('s1', 'non_camera_track');
  });

  it('kicks unknown identities that publish audio', async () => {
    const d = deps(false);
    expect(await handleStageEvent(published(TrackType.AUDIO, TrackSource.MICROPHONE), d)).toBe(
      'violation',
    );
    expect(d.removeParticipant).toHaveBeenCalled();
    expect(d.recordViolation).not.toHaveBeenCalled();
  });

  it('lets a performer camera track through and goes live', async () => {
    const d = deps();
    expect(await handleStageEvent(published(TrackType.VIDEO, TrackSource.CAMERA), d)).toBe('live');
    expect(d.removeParticipant).not.toHaveBeenCalled();
    expect(d.goLive).toHaveBeenCalledWith('s1');
  });
});
