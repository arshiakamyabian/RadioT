import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { AccessToken, RoomServiceClient, TrackType, TrackSource } from 'livekit-server-sdk';

// Mic enforcement against a real LiveKit server (layers 2 and 3). Layer 1 and the webhook
// logic are also unit-tested: apps/web/lib/stage and apps/api/src/stage/mic-enforcement.test.ts.
const LIVEKIT_URL = 'ws://localhost:7880';
const KEY = 'devkey';
const SECRET = 'devsecret-devsecret-devsecret-devsecret';
// The UMD build isn't in the package's exports map, so resolve it next to the main entry.
const umd = join(
  dirname(createRequire(import.meta.url).resolve('livekit-client')),
  'livekit-client.umd.js',
);

async function livekitUp() {
  try {
    return (
      (await fetch('http://localhost:7880')).ok &&
      (await (await fetch('http://localhost:4000/api/stage')).json()).enabled
    );
  } catch {
    return false;
  }
}

async function token(identity: string, restricted: boolean) {
  const at = new AccessToken(KEY, SECRET, { identity, ttl: 300 });
  at.addGrant({
    roomJoin: true,
    room: 'radiot-stage',
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    ...(restricted ? { canPublishSources: [TrackSource.CAMERA] } : {}),
  });
  return at.toJwt();
}

/** Connects with livekit-client in the page and tries to publish a microphone track. */
async function tryPublishMic(page: Page, jwt: string, holdMs = 8000) {
  await page.goto('/en/embed');
  await page.addScriptTag({ path: umd });
  return page.evaluate(
    async ({ url, jwt, holdMs }) => {
      // reason: the UMD bundle exposes a global without types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const LK = (window as any).LivekitClient;
      const room = new LK.Room();
      const disconnected = new Promise<string>((r) =>
        room.on(LK.RoomEvent.Disconnected, (reason: unknown) => r(String(reason))),
      );
      await room.connect(url, jwt);
      // A synthesized audio track (what a tampered client would send); avoids needing a capture device.
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      const mic = new LK.LocalAudioTrack(dest.stream.getAudioTracks()[0]);
      let publishError: string | null = null;
      try {
        await Promise.race([
          room.localParticipant.publishTrack(mic, { source: LK.Track.Source.Microphone }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('publish timed out')), 10_000)),
        ]);
      } catch (e) {
        publishError = String((e as Error).message ?? e);
      }
      const reason = await Promise.race([
        disconnected,
        new Promise<string>((r) => setTimeout(() => r('still-connected'), holdMs)),
      ]);
      return { publishError, reason, state: room.state };
    },
    { url: LIVEKIT_URL, jwt, holdMs },
  );
}

test.describe('mic enforcement on a real LiveKit server', () => {
  test('layer 2: a performer grant cannot publish a microphone', async ({ page }, info) => {
    test.setTimeout(60_000);
    test.skip(
      info.project.name !== 'desktop' || !(await livekitUp()),
      'desktop only; needs local LiveKit + API',
    );
    const identity = `performer-l2-${Date.now()}`;
    const rooms = new RoomServiceClient('http://localhost:7880', KEY, SECRET);
    const attempt = tryPublishMic(page, await token(identity, true), 25_000);
    // While the client is still connected, ask the server what it actually accepted.
    await expect
      .poll(
        async () =>
          (await rooms.listParticipants('radiot-stage')).some((p) => p.identity === identity),
        { timeout: 10_000 },
      )
      .toBe(true);
    await page.waitForTimeout(12_000);
    const me = (await rooms.listParticipants('radiot-stage')).find((p) => p.identity === identity);
    expect(me?.tracks.filter((t) => t.type === TrackType.AUDIO) ?? []).toHaveLength(0);
    expect((await attempt).publishError).toBeTruthy();
  });

  test('layer 3: audio from an unrestricted token is kicked by the webhook', async ({
    page,
  }, info) => {
    test.skip(
      info.project.name !== 'desktop' || !(await livekitUp()),
      'desktop only; needs local LiveKit + API',
    );
    const res = await tryPublishMic(page, await token(`rogue-${Date.now()}`, false));
    expect(res.reason).not.toBe('still-connected');
    expect(res.state).toBe('disconnected');
  });
});
