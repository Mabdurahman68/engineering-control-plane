import { spawn } from 'node:child_process';
import type { CommandResult, CommandRunner } from '../worktree/port.ts';

// Gates run with a scrubbed environment: no credentials, no inherited shell state.
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', CI: '1' };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

export class RealCommandRunner implements CommandRunner {
  run(argv: string[], opts: { cwd: string; timeout_s: number }): Promise<CommandResult> {
    return new Promise((resolve) => {
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
      const finish = (code: number) => {
        clearTimeout(timer);
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
