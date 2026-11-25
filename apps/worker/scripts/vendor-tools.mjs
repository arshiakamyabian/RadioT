/* global process, console, URL, fetch, Buffer */
// Copies static ffmpeg and fpcalc binaries into vendor/ so the Vercel function can run them.
// Only runs on Linux x64 (Vercel's build image); locally the system binaries are used instead.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.log('vendor-tools: not linux-x64, using system ffmpeg/fpcalc');
  process.exit(0);
}

const FPCALC_VERSION = '1.5.1';
const vendor = new URL('../vendor/', import.meta.url).pathname;
mkdirSync(vendor, { recursive: true });

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
if (!ffmpeg || !existsSync(ffmpeg))
  throw new Error('ffmpeg-static binary missing (did its install script run?)');
copyFileSync(ffmpeg, join(vendor, 'ffmpeg'));
chmodSync(join(vendor, 'ffmpeg'), 0o755);

if (!existsSync(join(vendor, 'fpcalc'))) {
  const name = `chromaprint-fpcalc-${FPCALC_VERSION}-linux-x86_64`;
  const res = await fetch(
    `https://github.com/acoustid/chromaprint/releases/download/v${FPCALC_VERSION}/${name}.tar.gz`,
  );
  if (!res.ok) throw new Error(`fpcalc download failed: ${res.status}`);
  const tgz = join(tmpdir(), `${name}.tar.gz`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['xzf', tgz, '-C', vendor, '--strip-components=1', `${name}/fpcalc`]);
  chmodSync(join(vendor, 'fpcalc'), 0o755);
}
console.log('vendor-tools: ffmpeg + fpcalc ready in vendor/');
