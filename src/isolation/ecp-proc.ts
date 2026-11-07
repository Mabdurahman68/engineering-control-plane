import { spawnSync } from 'node:child_process';

// The fixed helper that controls another user's processes on the dedicated machine. Not built here:
// M11 owns the helper itself. This is the coordinator's side of it, tested with a fake.
export const PROC_COMMANDS = ['scan', 'spawn', 'kill-all'] as const;
export type ProcCommand = (typeof PROC_COMMANDS)[number];

export function validProcArgs(command: string, attemptId: string): command is ProcCommand {
  return (
    (PROC_COMMANDS as readonly string[]).includes(command) &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(attemptId)
  );
}

export class ProcControlBlocked extends Error {}

export class ProcControl {
  private readonly helper: string;
  constructor(helper: string) {
    this.helper = helper;
  }
  private call(command: string, attemptId: string): { code: number; stdout: string } {
    if (!validProcArgs(command, attemptId)) throw new Error(`refused: ${command} ${attemptId}`);
    const r = spawnSync(this.helper, [command, attemptId], { encoding: 'utf8', timeout: 30_000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? '' };
  }
  // Before any new attempt, every process of the worker user goes, confirmed by the helper's count.
  // Anything but a clean zero stops the dispatch.
  beforeRedispatch(attemptId: string): void {
    const r = this.call('kill-all', attemptId);
    const count = Number(r.stdout.trim());
    if (r.code !== 0 || r.stdout.trim() === '' || !Number.isInteger(count) || count !== 0) {
      throw new ProcControlBlocked(
        `worker user still has processes: ${r.stdout.trim() || `exit ${r.code}`}`,
      );
    }
  }
  scan(attemptId: string): string {
    return this.call('scan', attemptId).stdout;
  }
}

// kill-all reaches everything that user owns, so two writers can't share one once a real rung exists.
export function writerCap(o: { configured: number; realRung: boolean }): number {
  return o.realRung ? Math.min(o.configured, 1) : o.configured;
}
