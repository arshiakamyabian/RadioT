import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPublicUrl, downloadWithYtdlp, isPrivateAddress } from './net.js';

describe('SSRF guard', () => {
  it('flags private, loopback and link-local addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('rejects localhost URLs and non-http schemes', async () => {
    await expect(assertPublicUrl('http://localhost:9000/x.mp3')).rejects.toThrow();
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
  });
});

describe('yt-dlp download', () => {
  // A stand-in for yt-dlp: `mode` decides what it does with the -o template.
  async function fakeBin(mode: 'ok' | 'none' | 'gone') {
    const dir = await mkdtemp(join(tmpdir(), 'fake-ytdlp-'));
    const bin = join(dir, 'yt-dlp');
    await writeFile(
      bin,
      `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
out=$(echo "$2" | sed 's/%(ext)s/mp3/')
case ${mode} in
  ok) echo audio > "$out"; echo "$out"; exit 101 ;;
  none) exit 0 ;;
  gone) echo "ERROR: [soundcloud] x: HTTP Error 404: Not Found" >&2; exit 1 ;;
esac
`,
    );
    await chmod(bin, 0o755);
    return { bin, file: join(dir, 'raw') };
  }

  it('moves the downloaded file into place', async () => {
    const { bin, file } = await fakeBin('ok');
    await downloadWithYtdlp('https://soundcloud.com/a/b', file, 1e6, bin);
    expect((await readFile(file, 'utf8')).trim()).toBe('audio');
  });

  it('rejects for good when nothing full-length matched or the track is gone', async () => {
    const none = await fakeBin('none');
    await expect(
      downloadWithYtdlp('scsearch5:x y', none.file, 1e6, none.bin),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/no full-length/) });
    const gone = await fakeBin('gone');
    await expect(
      downloadWithYtdlp('https://soundcloud.com/a/b', gone.file, 1e6, gone.bin),
    ).rejects.toMatchObject({ permanent: true });
  });
});
