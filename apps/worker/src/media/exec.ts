import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}) {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 5 * 60_000);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err, code: code ?? -1 });
    });
  });
}

export async function runOk(cmd: string, args: string[], opts?: RunOptions) {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) throw new Error(`${cmd} exited ${res.code}: ${res.stderr.slice(-500)}`);
  return res;
}
