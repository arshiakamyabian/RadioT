import { describe, expect, it, vi } from 'vitest';
import { cameraConstraints, openCamera } from './media';

describe('mic enforcement — layer 1: client capture', () => {
  it('never requests audio', () => {
    expect(cameraConstraints().audio).toBe(false);
    expect(cameraConstraints().video).toBeTruthy();
  });

  it('stops and strips any audio track a browser returns anyway', async () => {
    const audio = { kind: 'audio', stop: vi.fn() };
    const video = { kind: 'video', stop: vi.fn() };
    const tracks = [audio, video];
    const stream = {
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      removeTrack: (t: typeof audio) => tracks.splice(tracks.indexOf(t), 1),
    };
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      expect(c.audio).toBe(false);
      return stream as unknown as MediaStream;
    });
    const track = await openCamera(gum);
    expect(track).toBe(video);
    expect(audio.stop).toHaveBeenCalled();
    expect(stream.getAudioTracks()).toHaveLength(0);
  });
});
