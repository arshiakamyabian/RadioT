import { expect, test } from '@playwright/test';
import { infraUp, makeSong, signIn } from './helpers';

// Phase 4 + 5 exit: user A uploads a song, it is analyzed into the vote, user B votes for it,
// the round locks and the song plays next. Needs the full local stack (docker compose + pnpm dev).
test('two users: request → vote → winner plays next', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'one full-stack run is enough');
  test.skip(!(await infraUp()), 'needs local infra and dev servers');
  test.setTimeout(240_000);

  const stamp = Date.now();
  const title = `E2E Song ${stamp}`;
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();

  await signIn(a, `requester-${stamp}@example.com`);
  await a.goto('/en');
  await a.getByRole('button', { name: 'Request a song' }).click();
  const dialog = a.getByRole('dialog', { name: 'Request a song' });
  await dialog.getByLabel(/Audio file/).setInputFiles(makeSong(title));
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Submit request' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // Worker pipeline: validate → transcode → analyze → finalize.
  const mine = a
    .getByRole('region', { name: 'Your requests' })
    .or(a.locator('section[aria-labelledby="mine-title"]'));
  await expect(mine.getByText(title)).toBeVisible();
  await expect(mine.getByText('In the vote')).toBeVisible({ timeout: 60_000 });

  await signIn(b, `voter-${stamp}@example.com`);
  await b.goto('/en');
  const row = b.getByRole('listitem').filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // The current round may already be locked; the button enables when the next one opens.
  const voteButton = row.getByRole('button', { name: 'Vote' });
  await expect(voteButton).toBeEnabled({ timeout: 90_000 });
  await voteButton.click();
  await expect(row.getByRole('button', { name: 'Your vote' })).toBeVisible();
  await expect(row.getByText('1 vote')).toBeVisible();

  // Lock → Liquidsoap request queue → next transition → radio:now.
  await expect(a.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 150_000 });
  await expect(b.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(b.getByText(/Requested by/).first()).toBeVisible();
});
