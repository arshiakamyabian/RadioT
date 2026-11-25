import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stderr: string;
}

/** Runs a command to completion (output is discarded, the last 2 kB of stderr is kept). */
export function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr: err });
    });
  });
}
