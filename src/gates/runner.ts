import { spawn } from 'node:child_process';
import { GateStopped } from '../core/ports.ts';
import type { CommandResult, CommandRunner } from '../worktree/port.ts';

// Gates run with a scrubbed environment: no credentials, no inherited shell state.
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', CI: '1' };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

export class RealCommandRunner implements CommandRunner {
  private readonly shouldStop: () => boolean;
  constructor(shouldStop: () => boolean = () => false) {
    this.shouldStop = shouldStop;
  }
  run(argv: string[], opts: { cwd: string; timeout_s: number }): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let log = '';
      let timedOut = false;
      const child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: { ...scrubbedEnv(), HOME: opts.cwd },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const add = (b: Buffer) => {
        if (log.length < 4_000_000) log += b.toString();
      };
      child.stdout?.on('data', add);
      child.stderr?.on('data', add);
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 5000).unref();
      }, opts.timeout_s * 1000);
      // The coordinator is in here, so the operator's request has to be noticed here too.
      let stopped = false;
      const watch = setInterval(() => {
        if (stopped || !this.shouldStop()) return;
        stopped = true;
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 2000).unref();
      }, 200);
      const finish = (code: number) => {
        clearTimeout(timer);
        clearInterval(watch);
        if (stopped) {
          reject(new GateStopped());
          return;
        }
        resolve({ code, log, duration_ms: Date.now() - started, timed_out: timedOut });
      };
      child.on('error', (e) => {
        log += String(e);
        finish(127);
      });
      child.on('close', (code) => {
        killGroup('SIGKILL');
        finish(code ?? 1);
      });
    });
  }
}
