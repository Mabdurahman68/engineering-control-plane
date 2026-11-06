import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { until } from './fake-cli.ts';

const HOLDER = resolve('test/support/lock-holder.ts');

// A holder process, and a way to ask it something and wait for the answer.
export function holder(home: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [HOLDER, home], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const lines: any[] = [];
  let err = '';
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
    child.on('exit', (code, signal) => r({ code, signal })),
  );
  const ask = async (cmd: string, ms = 30_000) => {
    const before = lines.length;
    child.stdin.write(`${cmd}\n`);
    if (!(await until(() => lines.length > before, ms)))
      throw new Error(`no answer to ${cmd}: ${err}`);
    return lines[before];
  };
  const ready = until(() => lines.length > 0, 30_000);
  return {
    child: child as ChildProcess,
    ask,
    ready,
    exited,
    stderr: () => err,
    pid: () => child.pid as number,
  };
}

export const openFds = () => readdirSync('/dev/fd').length;
