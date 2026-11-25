import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize } from 'node:path';
import { createDeps } from './deps.js';
import { handleMediaRequest } from './jobs.js';

// Local stand-in for the Vercel function in api/media.mjs.
const { env, deps, log } = createDeps();

const MIME: Record<string, string> = { mp3: 'audio/mpeg', jpg: 'image/jpeg' };

/** Dev only: serves LOCAL_MEDIA_DIR like the Blob CDN does (CORS-open, byte ranges). */
async function serveLocalMedia(req: IncomingMessage, res: ServerResponse, dir: string) {
  const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0]!.slice('/media/'.length)));
  if (rel.startsWith('..')) return void res.writeHead(400).end();
  const file = join(dir, rel);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return void res.writeHead(404).end();
  const headers: Record<string, string | number> = {
    'access-control-allow-origin': '*',
    'accept-ranges': 'bytes',
    'content-type': MIME[file.split('.').pop() ?? ''] ?? 'application/octet-stream',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'content-length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': info.size });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  void (async () => {
    if (env.LOCAL_MEDIA_DIR && req.method === 'GET' && req.url?.startsWith('/media/')) {
      await serveLocalMedia(req, res, env.LOCAL_MEDIA_DIR);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/media') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const response = await handleMediaRequest(
      new Request(`http://localhost${req.url}`, {
        method: 'POST',
        headers,
        body: Buffer.concat(chunks),
      }),
      env,
      deps,
      (work) => void work,
    );
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(await response.text());
  })().catch((err: Error) => {
    log.warn({ err: err.message }, 'request failed');
    res.writeHead(500).end();
  });
});
server.listen(env.PORT, () => log.info({ port: env.PORT }, 'worker ready'));
