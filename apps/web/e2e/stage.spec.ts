import { expect, test } from '@playwright/test';
import { infraUp, makeSong, signIn } from './helpers';

test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

// Phase 6 exit: the user whose song is playing goes live on camera (video only) and viewers see it.
test('performer goes live on camera while their song plays', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'one full-stack run is enough');
  test.skip(!(await infraUp()), 'needs local infra, LiveKit and dev servers');
  const stage = await (await fetch('http://localhost:4000/api/stage')).json();
  test.skip(!stage.enabled, 'LiveKit not configured');
  test.setTimeout(300_000);

  const stamp = Date.now();
  const title = `Stage Song ${stamp}`;
  const ctxA = await browser.newContext({ permissions: ['camera'] });
  const a = await ctxA.newPage();
  const viewer = await (await browser.newContext()).newPage();

  await signIn(a, `performer-${stamp}@example.com`);
  await a.goto('/en');
  await a.getByRole('button', { name: 'Request a song' }).click();
  const dialog = a.getByRole('dialog', { name: 'Request a song' });
  await dialog.getByLabel(/Audio file/).setInputFiles(makeSong(title, 45));
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Submit request' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // Single candidate wins the next lock without votes, then airs.
  await expect(a.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 200_000 });

  // The heading (and so the region's name) changes to "<name> is live" once live.
  const stageSection = a.locator('section[aria-labelledby="stage-title"]');
  await expect(
    stageSection.getByText('Camera only — your microphone is never used.'),
  ).toBeVisible();
  await stageSection.getByRole('checkbox').check();
  await stageSection.getByRole('button', { name: 'Go live on camera' }).click();
  await expect(stageSection.getByRole('button', { name: 'Leave stage' })).toBeVisible({
    timeout: 20_000,
  });

  // The performer's page never captured audio.
  expect(
    await a.evaluate(() =>
      [...document.querySelectorAll('video')].every(
        (v) => !(v.srcObject instanceof MediaStream) || v.srcObject.getAudioTracks().length === 0,
      ),
    ),
  ).toBe(true);

  await viewer.goto('/en');
  await expect(viewer.getByRole('heading', { name: /is live$/ })).toBeVisible({ timeout: 20_000 });
  // Video arrives over WebRTC and is painted (delayed) onto the stage canvas or video.
  await expect(
    viewer.locator('section[aria-labelledby="stage-title"]').locator('canvas, video').first(),
  ).toBeAttached({ timeout: 30_000 });

  await stageSection.getByRole('button', { name: 'Leave stage' }).click();
  await expect(viewer.getByRole('heading', { name: /is live$/ })).toBeHidden({ timeout: 20_000 });
});
