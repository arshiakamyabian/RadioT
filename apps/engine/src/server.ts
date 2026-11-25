import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { Engine } from './engine.js';
import type { Env } from './env.js';

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
};

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

function cors(env: Env, req: IncomingMessage, res: ServerResponse) {
  const allowed = env.CORS_ORIGINS.split(',').map((s) => s.trim());
  const origin = req.headers.origin;
  if (allowed.includes('*')) res.setHeader('access-control-allow-origin', '*');
  else if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('access-control-allow-headers', 'range, content-type, icy-metadata');
  res.setHeader(
    'access-control-expose-headers',
    'content-length, content-range, content-type, icy-metaint, date',
  );
}

const isLoopback = (req: IncomingMessage) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

async function readBody(req: IncomingMessage, limit = 64_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createEngineServer(env: Env, engine: Engine, hlsDir: string, log: Log) {
  const sse = new Set<ServerResponse>();
  engine.subscribe((state) => {
    const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of sse) res.write(frame);
  });
  setInterval(() => {
    for (const res of sse) res.write(': keepalive\n\n');
  }, 15_000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://engine');
    cors(env, req, res);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === '/health') return json(res, engine.health());
      if (url.pathname === '/now') {
        res.setHeader('cache-control', 'no-store');
        return json(res, engine.state());
      }
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(engine.state())}\n\n`);
        sse.add(res);
        req.on('close', () => sse.delete(res));
        return;
      }
      if (url.pathname === '/liq/on-air' && req.method === 'POST') {
        if (!isLoopback(req)) return void res.writeHead(403).end();
        // Liquidsoap serialises metadata as a list of [key, value] pairs.
        const raw = JSON.parse(await readBody(req)) as unknown;
        const meta: Record<string, unknown> = Array.isArray(raw) ? Object.fromEntries(raw) : {};
        if (typeof meta.radiot_id === 'string') engine.noteOnAir(meta.radiot_id);
        return void res.writeHead(204).end();
      }
      if (url.pathname.startsWith('/hls/'))
        return serveHls(req, res, url.pathname.slice(5), hlsDir);
      if (url.pathname === '/radiot.mp3') return proxyMp3(req, res, env);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (err) {
      log.warn({ err: (err as Error).message, path: url.pathname }, 'request failed');
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('error');
    }
  });
  server.keepAliveTimeout = 65_000;
  return server;
}

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function serveHls(req: IncomingMessage, res: ServerResponse, name: string, dir: string) {
  const file = normalize(join(dir, name));
  if (!file.startsWith(dir + sep)) return void res.writeHead(403).end();
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return void res.writeHead(404, { 'cache-control': 'no-store' }).end();
  const playlist = file.endsWith('.m3u8');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    // Playlists change every segment and must never be cached; segments never change.
    'cache-control': playlist ? 'no-store' : 'public, max-age=60, immutable',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

/** Proxies the Icecast MP3 mount, so one origin and one port serve every output. */
function proxyMp3(req: IncomingMessage, res: ServerResponse, env: Env) {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: env.ICECAST_PORT,
      path: '/radiot.mp3',
      headers: { 'user-agent': 'radiot-engine' },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, {
        'content-type': 'audio/mpeg',
        'cache-control': 'no-store',
        'icy-name': 'RadioT',
      });
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('stream unavailable');
  });
  req.on('close', () => upstream.destroy());
  upstream.end();
}
