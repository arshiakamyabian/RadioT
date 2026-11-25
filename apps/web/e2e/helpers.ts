import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export async function infraUp() {
  try {
    return (
      (await fetch(`${MAILPIT}/api/v1/info`)).ok && (await fetch('http://localhost:4000/health')).ok
    );
  } catch {
    return false;
  }
}

export async function latestLinkFor(email: string) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const { messages } = (await res.json()) as { messages: { ID: string }[] };
    if (messages[0]) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${messages[0].ID}`)).json()) as {
        Text: string;
      };
      const link = msg.Text.match(/https?:\/\/\S+/)?.[0];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no magic link for ${email}`);
}

export async function signIn(page: Page, email: string) {
  await page.goto('/en/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send magic link' }).click();
  await expect(page.getByRole('status')).toContainText(email);
  await page.goto(await latestLinkFor(email));
  // Guest mode has no sign-in/out UI; confirm the session belongs to this email instead.
  await expect
    .poll(
      async () =>
        (await page.request.get('http://localhost:4000/api/me')).ok() &&
        (await (await page.request.get('http://localhost:4000/api/me')).json()).user.email,
    )
    .toBe(email);
}

/** A short synthesized, royalty-free test song (needs ffmpeg). */
export function makeSong(title: string, seconds = 20) {
  const dir = join(process.cwd(), 'test-results', 'audio');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${title.replace(/\W+/g, '-')}.mp3`);
  if (!existsSync(file)) {
    execFileSync('ffmpeg', [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=330:duration=${seconds}`,
      '-af',
      'volume=0.5,afade=t=out:st=' + (seconds - 4) + ':d=4',
      '-ac',
      '2',
      '-metadata',
      `title=${title}`,
      '-metadata',
      'artist=E2E',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      file,
    ]);
  }
  return file;
}
