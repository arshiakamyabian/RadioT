import { expect, test } from '@playwright/test';

test('home shows the station and links to the request page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole('link', { name: 'RadioT', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('banner').getByRole('link', { name: 'Request a song' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Request a song' })).toBeVisible();
});

test('pressing play starts the live stream on the one global audio element', async ({ page }) => {
  await page.goto('/en');
  const audio = page.locator('#radiot-audio');
  await expect(audio).toHaveCount(1);
  // Nothing plays or loads until the tap.
  expect(await audio.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(true);
  await page.getByRole('button', { name: 'Play live radio' }).first().click();
  // Apple's browsers play the HLS playlist themselves; others use hls.js; old ones the MP3.
  await expect(audio).toHaveAttribute('data-transport', /^(native|hlsjs|mp3)$/, {
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible();
});

test('the audio element survives client-side navigation and is never duplicated', async ({
  page,
}) => {
  await page.goto('/en');
  const handle = await page.locator('#radiot-audio').elementHandle();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Charts' })
    .click();
  await expect(page).toHaveURL(/\/en\/charts$/, { timeout: 20_000 });
  expect(await handle?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(page.locator('audio')).toHaveCount(1);
});

test('turkish locale renders translated copy', async ({ page }) => {
  await page.goto('/tr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.getByRole('heading', { name: 'Sıradaki şarkıyı oyla' })).toBeVisible();
});
