import { execFile } from 'node:child_process';
import type { ProcKiller, ProcRecord, ProcScanner } from '../../core/ports.ts';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (_e, stdout) =>
      resolve(stdout ?? ''),
    );
  });
}

// Best effort, by design at this stage: a process that rewrites its argv and changes directory
// escapes this scan. Real containment is held for the dedicated machine (M11).
export class RealScanner implements ProcScanner {
  async scan(a: { attempt_id: string; out_dir: string; cwd: string }): Promise<ProcRecord[]> {
    const out = await run('ps', ['-ww', '-axo', 'pid=,lstart=,command=']);
    const me = process.pid;
    const found: ProcRecord[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === me) continue;
      if (m[3].includes(a.out_dir)) found.push({ pid, start_time: m[2], argv: m[3], cwd: null });
    }
    // A child usually keeps the worktree as its working directory, without the attempt in its argv.
    const cwdHits = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '+D', a.cwd]);
    let current: number | null = null;
    for (const line of cwdHits.split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1));
      if (
        line.startsWith('n') &&
        current !== null &&
        current !== me &&
        !found.some((x) => x.pid === current)
      ) {
        found.push({ pid: current, start_time: null, argv: '', cwd: line.slice(1) });
      }
    }
    return found;
  }
  async isAlive(pid: number, startTime: string | null): Promise<boolean> {
    const out = (await run('ps', ['-o', 'lstart=', '-p', String(pid)])).trim();
    if (!out) return false;
    return startTime === null || out.replace(/\s+/g, ' ') === startTime.replace(/\s+/g, ' ');
  }
}

export class RealKiller implements ProcKiller {
  async kill(pids: number[], signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    for (const pid of pids) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, signal);
        } catch {
          // Already gone, or no such group.
        }
      }
    }
  }
  sleep(ms: number) {
    return new Promise<void>((r) => {
      setTimeout(r, ms);
    });
  }
}
