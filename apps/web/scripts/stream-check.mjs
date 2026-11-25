// Drives the live stream in emulated phones and a desktop browser and checks that it keeps
// playing through the things that stopped playback on phones: network drops, blocked HLS,
// a frozen page, sleeping. Needs the local stack (infra/scripts/stream-dev.sh start).
//
//   node scripts/stream-check.mjs [--url http://localhost:3000] [--only iphone|pixel|desktop]
//
// iPhone 15 runs WebKit (native HLS, like Safari); Pixel 7 and desktop run Chromium (hls.js).
import { chromium, devices, webkit } from '@playwright/test';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const URL_ = arg('url', 'http://localhost:3000');
const ONLY = arg('only', '');

const profiles = [
  { name: 'iphone', label: 'iPhone 15 (WebKit)', browser: webkit, device: devices['iPhone 15'] },
  { name: 'pixel', label: 'Pixel 7 (Chromium)', browser: chromium, device: devices['Pixel 7'] },
  { name: 'desktop', label: 'Desktop Chromium', browser: chromium, device: {} },
].filter((p) => !ONLY || p.name === ONLY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function audioState(page) {
  return page.evaluate(() => {
    const a = document.getElementById('radiot-audio');
    return a
      ? {
          t: a.currentTime,
          paused: a.paused,
          ready: a.readyState,
          transport: a.dataset.transport ?? null,
          src: a.currentSrc.slice(0, 60),
          err: a.error?.code ?? null,
        }
      : null;
  });
}

async function waitFor(page, fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await audioState(page);
    if (s && fn(s)) return { ok: true, ms: Date.now() - t0, state: s };
    await sleep(250);
  }
  return { ok: false, ms: timeout, label, state: await audioState(page) };
}

/** Playhead advances by about the elapsed time over `ms` (no stall). */
async function advances(page, ms, label) {
  const a = await audioState(page);
  await sleep(ms);
  const b = await audioState(page);
  const moved = b && a ? b.t - a.t : 0;
  return { ok: moved > (ms / 1000) * 0.8, moved: Math.round(moved * 10) / 10, label };
}

async function run(profile) {
  const out = { profile: profile.label, checks: [] };
  const check = (name, r) => {
    out.checks.push({ name, ...r });
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${name}${r.moved !== undefined ? `  (moved ${r.moved}s)` : ''}${r.ms !== undefined && r.ok ? `  (${r.ms} ms)` : ''}`,
    );
  };
  console.log(`\n${profile.label}`);
  const browser = await profile.browser.launch({
    args: profile.browser === chromium ? ['--autoplay-policy=no-user-gesture-required'] : [],
  });
  const context = await browser.newContext({ ...profile.device, baseURL: URL_ });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 160)));
  await page.goto('/en', { waitUntil: 'domcontentloaded' });
  await page.locator('#radiot-audio').waitFor({ state: 'attached', timeout: 20_000 });

  // 1. nothing plays until the tap
  const before = await audioState(page);
  check('no autoplay before the tap', { ok: !!before && before.paused && before.t === 0 });

  // 2. tap play (after hydration, so the click reaches the React handler)
  await sleep(3000);
  await page.getByRole('button', { name: 'Play live radio' }).first().click({ timeout: 15_000 });
  const started = await waitFor(
    page,
    (s) => !s.paused && s.t > 1.5 && s.ready >= 3,
    45_000,
    'start',
  );
  check(`starts playing (transport: ${started.state?.transport})`, started);
  if (!started.ok) {
    console.log('   state:', JSON.stringify(started.state));
    await browser.close();
    out.errors = consoleErrors;
    return out;
  }
  check('keeps playing for 10 s', await advances(page, 10_000, 'steady'));

  // 3. page JavaScript frozen (a hidden page's timers are throttled hard). With hls.js the
  // buffered audio must keep playing meanwhile. On iPhone WebKit plays the playlist itself and a
  // locked page is suspended by the OS, not blocked, which this cannot emulate: skipped there.
  if (profile.browser === chromium) {
    const t0 = (await audioState(page)).t;
    await page.evaluate(() => {
      const end = Date.now() + 15_000;
      while (Date.now() < end); // blocks the main thread
    });
    const ranOn = (await audioState(page)).t - t0;
    // A live stream can only buffer what already exists: the runway is how far behind the live
    // edge we sit (8-10 s on phones). Past that it stalls, and must recover by itself.
    const resumed = await waitFor(page, (s) => !s.paused && s.ready >= 3, 25_000, 'after freeze');
    const after = await advances(page, 5000, 'after freeze');
    check(
      `recovers by itself after 15 s of frozen page JavaScript (played on for ${Math.round(ranOn)} s of it)`,
      {
        ok: resumed.ok && after.ok,
        ms: resumed.ms,
        moved: after.moved,
      },
    );
  } else {
    console.log('  skip  frozen page JavaScript (not representative for native HLS)');
  }

  // 4. Wi-Fi drops for 8 s, then returns (Playwright only cuts requests the page itself makes,
  // so for native HLS on WebKit this exercises little; hls.js on Chromium is the real test)
  await context.setOffline(true);
  await sleep(8000);
  await context.setOffline(false);
  const back = await waitFor(page, (s) => !s.paused && s.ready >= 3, 40_000, 'after offline');
  const marker = (await audioState(page))?.t ?? 0;
  await sleep(4000);
  const afterOffline = (await audioState(page))?.t ?? 0;
  check('recovers after an 8 s network drop', {
    ok: back.ok && afterOffline - marker > 3,
    ms: back.ms,
    moved: Math.round((afterOffline - marker) * 10) / 10,
  });

  // 5. HLS blocked (a proxy that mangles it): falls back to the MP3 stream
  if (started.state.transport !== 'mp3') {
    await page.route('**/hls/**', (r) => r.abort());
    // Force a reconnect so the blocked HLS is actually hit.
    await context.setOffline(true);
    await sleep(500);
    await context.setOffline(false);
    const mp3 = await waitFor(
      page,
      (s) => s.transport === 'mp3' && !s.paused && s.t > 1 && s.ready >= 3,
      75_000,
      'mp3 fallback',
    );
    check('falls back to the MP3 stream when HLS is blocked', mp3);
    if (mp3.ok) check('MP3 fallback plays', await advances(page, 6000, 'mp3'));
    await page.unroute('**/hls/**');
  }

  check('no console errors from the player', {
    ok: !consoleErrors.some((e) => /radiot|hls|audio/i.test(e)),
    errors: consoleErrors.slice(0, 3),
  });
  await browser.close();
  out.errors = consoleErrors;
  return out;
}

for (const p of profiles) {
  try {
    results.push(await run(p));
  } catch (err) {
    console.log(`  ERROR ${err.message.split('\n')[0]}`);
    results.push({ profile: p.label, error: err.message });
  }
}
const failed =
  results.flatMap((r) => (r.checks ?? []).filter((c) => !c.ok)).length +
  results.filter((r) => r.error).length;
console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
