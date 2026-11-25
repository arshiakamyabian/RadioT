import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from './env.js';

type Log = {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  debug: (o: object, m: string) => void;
};

const root = fileURLToPath(new URL('..', import.meta.url));

export const runPaths = (env: Env) => ({
  hls: join(env.RUN_DIR, 'hls'),
  cache: join(env.RUN_DIR, 'media'),
  logs: join(env.RUN_DIR, 'logs'),
});

/** Starts Icecast and Liquidsoap next to the engine (dev, and single-box deployments), restarting them if they die. */
export class Supervisor {
  private children = new Map<string, ChildProcess>();
  private stopping = false;

  constructor(
    private readonly env: Env,
    private readonly log: Log,
  ) {}

  async start() {
    const dirs = runPaths(this.env);
    await mkdir(dirs.cache, { recursive: true });
    await mkdir(dirs.logs, { recursive: true });
    // Old segments belong to a previous run of the stream; players must not see them.
    await rm(dirs.hls, { recursive: true, force: true });
    await mkdir(dirs.hls, { recursive: true });
    await this.startIcecast(dirs.logs);
    this.startLiquidsoap(dirs.hls);
    await this.waitForPort(this.env.LIQ_TELNET_PORT, 60_000);
  }

  stop() {
    this.stopping = true;
    for (const child of this.children.values()) child.kill('SIGTERM');
  }

  private async startIcecast(logs: string) {
    const tmpl = await readFile(join(root, 'icecast/icecast.xml.tmpl'), 'utf8');
    const xml = tmpl
      .replaceAll('{{SOURCE_PASSWORD}}', this.env.ICECAST_SOURCE_PASSWORD)
      .replaceAll('{{ADMIN_PASSWORD}}', this.env.ICECAST_ADMIN_PASSWORD)
      .replaceAll('{{PORT}}', String(this.env.ICECAST_PORT))
      .replaceAll('{{BIND}}', '127.0.0.1')
      .replaceAll('{{SHARE}}', this.env.ICECAST_SHARE)
      .replaceAll('{{RUN}}', logs);
    const file = join(logs, 'icecast.xml');
    await writeFile(file, xml);
    this.spawnKeepAlive('icecast', this.env.ICECAST_PATH, ['-c', file], {});
  }

  private startLiquidsoap(hls: string) {
    this.spawnKeepAlive(
      'liquidsoap',
      this.env.LIQUIDSOAP_PATH,
      [join(root, 'liquidsoap/radiot.liq')],
      {
        HLS_DIR: hls,
        LIQ_TELNET_PORT: String(this.env.LIQ_TELNET_PORT),
        ICECAST_PORT: String(this.env.ICECAST_PORT),
        ICECAST_SOURCE_PASSWORD: this.env.ICECAST_SOURCE_PASSWORD,
        ENGINE_URL: `http://127.0.0.1:${this.env.PORT}`,
        HLS_SEGMENT_SECONDS: String(this.env.HLS_SEGMENT_SECONDS),
        HLS_SEGMENTS: String(this.env.HLS_SEGMENTS),
      },
    );
  }

  private spawnKeepAlive(name: string, cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv) {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    this.children.set(name, child);
    const forward = (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim() && !/ffmpeg\.filter/.test(line))
          this.log.debug({ proc: name }, line.trim().slice(0, 300));
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => this.log.warn({ proc: name, err: err.message }, 'could not start'));
    child.on('exit', (code) => {
      if (this.stopping) return;
      this.log.warn({ proc: name, code }, 'exited, restarting in 2 s');
      setTimeout(() => !this.stopping && this.spawnKeepAlive(name, cmd, args, extraEnv), 2000);
    });
    this.log.info({ proc: name, pid: child.pid }, 'started');
  }

  private waitForPort(port: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const attempt = () => {
        const s = createConnection({ port, host: '127.0.0.1' });
        s.once('connect', () => {
          s.destroy();
          resolve();
        });
        s.once('error', () => {
          s.destroy();
          if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
          else setTimeout(attempt, 300);
        });
      };
      attempt();
    });
  }
}
