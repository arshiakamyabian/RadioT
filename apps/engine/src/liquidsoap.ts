import { createConnection, type Socket } from 'node:net';

/**
 * Minimal client for Liquidsoap's telnet server: one command at a time, each answered by lines
 * ending in `END`. Reconnects on demand, so Liquidsoap can be restarted under a running engine.
 */
export class LiquidsoapClient {
  private socket: Socket | null = null;
  private buffer = '';
  private waiting: { resolve: (lines: string[]) => void; reject: (e: Error) => void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1',
  ) {}

  /** Runs `command` and returns the reply lines (without the closing END). */
  command(command: string, timeoutMs = 4000): Promise<string[]> {
    const run = () => this.send(command, timeoutMs);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Appends a piece to the playout queue; resolves to Liquidsoap's request id. */
  async push(uri: string): Promise<string> {
    const reply = await this.command(`radio.push ${uri}`);
    return reply[0] ?? '';
  }

  /** Requests currently waiting in the queue (ids). */
  async queue(): Promise<string[]> {
    const reply = await this.command('radio.queue');
    return (reply[0] ?? '').split(' ').filter(Boolean);
  }

  /** Drops everything queued and cuts the piece on air. */
  async flushAndSkip() {
    await this.command('radio.flush_and_skip');
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    return new Promise((resolve, reject) => {
      const socket = createConnection({ port: this.port, host: this.host });
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        this.socket = socket;
        this.buffer = '';
        resolve(socket);
      });
      socket.once('error', (err) => {
        this.socket = null;
        reject(err);
      });
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('close', () => {
        this.socket = null;
        this.waiting?.reject(new Error('liquidsoap connection closed'));
        this.waiting = null;
      });
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const end = this.buffer.search(/(^|\r?\n)END\r?\n/);
    if (end < 0 || !this.waiting) return;
    const reply = this.buffer.slice(0, end);
    this.buffer = '';
    const lines = reply.split(/\r?\n/).filter((l) => l.length > 0);
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve(lines);
  }

  private async send(command: string, timeoutMs: number): Promise<string[]> {
    const socket = await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        socket.destroy();
        reject(new Error(`liquidsoap: no answer to "${command.slice(0, 40)}"`));
      }, timeoutMs);
      this.waiting = {
        resolve: (lines) => {
          clearTimeout(timer);
          resolve(lines);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.buffer = '';
      socket.write(`${command}\n`);
    });
  }
}

/**
 * `annotate:` URI for a piece file that is already cut to length: its id (reported back when it
 * goes on air), its gain, and the crossfade into the next piece (0 = a plain gapless join).
 */
export function annotateUri(file: string, meta: { id: string; gainDb: number; crossMs: number }) {
  const pairs = [
    `radiot_id="${meta.id}"`,
    `liq_amplify="${meta.gainDb.toFixed(2)} dB"`,
    `liq_cross_duration="${(meta.crossMs / 1000).toFixed(3)}"`,
  ];
  return `annotate:${pairs.join(',')}:${file}`;
}
