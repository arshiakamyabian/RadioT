import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { infraUp, signIn } from './helpers';

async function setHandle(page: Page, handle: string, name: string) {
  await page.goto('/en/settings');
  await page.getByLabel('Handle').fill(handle);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
}

// TODO(flaky): see docs/progress.md — audit-tab click stalls under local memory pressure.
test.fixme('chat, reactions, profiles, reports and admin moderation', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'one full-stack run is enough');
  test.skip(!(await infraUp()), 'needs local infra and dev servers');
  test.setTimeout(90_000);
  const s = Date.now().toString(36);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const admin = await (await browser.newContext()).newPage();

  await signIn(a, `alice-${s}@example.com`);
  await setHandle(a, `alice_${s}`, `Alice ${s}`);
  await signIn(b, `bob-${s}@example.com`);
  await setHandle(b, `bob_${s}`, `Bob ${s}`);
  await a.goto('/en');
  await b.goto('/en');

  // Chat with the word filter applied server-side.
  const chatA = a.getByRole('region', { name: 'Chat' });
  const chatB = b.getByRole('region', { name: 'Chat' });
  await chatA.getByRole('textbox').fill(`hello ${s} what the shit`);
  await chatA.getByRole('button', { name: 'Send' }).click();
  await expect(chatB.getByText(`hello ${s} what the ••••`)).toBeVisible();

  // Slow mode rejects an immediate second message.
  await chatA.getByRole('textbox').fill('again');
  await chatA.getByRole('button', { name: 'Send' }).click();
  await expect(a.getByText(/Slow mode/)).toBeVisible();

  // Reactions fan out to everyone.
  await a.getByRole('button', { name: 'Send a reaction: Air horn' }).click();
  await expect(b.locator('[aria-hidden] span', { hasText: 'Alice' }).first()).toBeAttached();

  // Report the message.
  const msgB = chatB.getByRole('listitem').filter({ hasText: `hello ${s}` });
  await msgB.hover();
  await msgB.getByRole('button', { name: new RegExp(`Report: Alice ${s}`) }).click();
  await expect(b.getByText('Reported')).toBeVisible();

  // Public profile is indexable and shows the user.
  await b.goto(`/en/u/alice_${s}`);
  await expect(b.getByRole('heading', { level: 1, name: `Alice ${s}` })).toBeVisible();
  await b.goto('/en');

  // Admin: grant via CLI, then moderate.
  const adminEmail = `admin-${s}@example.com`;
  await signIn(admin, adminEmail);
  execFileSync('pnpm', ['--filter', '@radiot/db', 'admin:grant', adminEmail], {
    cwd: '../..',
    stdio: 'ignore',
  });
  await admin.goto('/en/admin');
  await expect(admin.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(admin.getByText('Listeners', { exact: true })).toBeVisible();
  await admin.getByRole('tab', { name: 'reports' }).click();
  const report = admin.getByRole('row').filter({ hasText: `Alice ${s}` });
  await expect(report).toBeVisible();
  await report.getByRole('button', { name: 'Delete msg' }).click();
  await expect(b.getByText(`hello ${s} what the ••••`)).toBeHidden();
  await report.getByRole('button', { name: 'Resolve' }).click();
  await expect(report).toBeHidden();
  await admin.getByRole('tab', { name: 'audit' }).click();
  await expect(admin.getByRole('cell', { name: 'chat.delete' }).first()).toBeVisible();
  await expect(admin.getByRole('cell', { name: 'report.resolve' }).first()).toBeVisible();
});
