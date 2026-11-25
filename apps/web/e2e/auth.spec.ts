import { expect, test } from '@playwright/test';
import { infraUp, signIn } from './helpers';

test('guest mode: a new visitor can request a song without signing in', async ({ page }) => {
  test.skip(!(await infraUp()), 'needs local infra and dev servers');
  await page.goto('/en');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  await page.getByRole('banner').getByRole('link', { name: 'Request a song' }).click();
  await expect(page).toHaveURL(/\/en\/request$/);
  await expect(page.getByLabel(/Audio file/)).toBeVisible({ timeout: 15_000 });
});

test('magic link still works from /sign-in (for admins)', async ({ page }, info) => {
  test.skip(!(await infraUp()), 'needs local infra and dev servers');
  await signIn(page, `e2e-${info.project.name}-${Date.now()}@example.com`);
});
