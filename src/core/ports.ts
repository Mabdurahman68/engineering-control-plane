import type { DecisionObserver, PolicyBundle, Spec, WorkerAdapter } from '../contracts/index.ts';
import type { LedgerStore } from '../ledger/ledger.ts';
import type { CommandRunner, GitPort, RunStore } from '../worktree/port.ts';

// Thrown by a test failpoint to model a killed process: it passes through the engine untouched,
// so nothing runs that a real kill would have prevented. Production failpoints send SIGKILL.
export class SimulatedKill extends Error {}

export interface Clock {
  now(): number;
  // Waits until notified, or the given time. On a virtual clock, this advances time.
  idle(
    wakeAt: number | null,
    isNotified: () => boolean,
    subscribe: (fn: () => void) => void,
  ): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface IdSource {
  next(prefix: string): string;
  // Seeded jitter in [0, 1). Consumed only by steering code, so shadow calls can't shift it.
  random(): number;
}

export type ProcRecord = {
  pid: number;
  start_time: string | null;
  argv: string;
  cwd: string | null;
};

// Scan has no way to signal, by type: the one rule requires scanning first and signalling only after.
export interface ProcScanner {
  scan(attempt: { attempt_id: string; out_dir: string; cwd: string }): Promise<ProcRecord[]>;
  isAlive(pid: number, startTime: string | null): Promise<boolean>;
}
export interface ProcKiller {
  kill(pids: number[], signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type EnginePorts = {
  git: GitPort;
  runner: CommandRunner;
  store: RunStore;
  ledgerStore: LedgerStore;
  clock: Clock;
  ids: IdSource;
  adapters: Record<string, WorkerAdapter>;
  scanner: ProcScanner;
  killer: ProcKiller;
  observer: DecisionObserver | null;
  publisher: Publisher | null;
  policy: PolicyBundle;
  prompts: Record<string, string>;
  paths: {
    worktree(runId: string, taskId: string, gen: number): string;
    checkout(runId: string, name: string): string;
  };
  failpoint(name: string): void;
  // Operator requests, never overwritten: each is acknowledged in the ledger before its file goes.
  pendingControl(): { id: string; request: 'pause' | 'cancel' }[];
  ackControl(id: string): void;
  // How often a real coordinator looks for requests while idle. Unset in simulation.
  controlPollMs?: number;
  notify(kind: string, summary: string): void;
  // Sum of per-day figures from other runs' ledgers, under the global lock. Zero when absent.
  dayUsage(): {
    invocations: number;
    wall_clock_s: number;
    usd: number;
    shadow_invocations: number;
  };
  // Output only; they read state and change nothing. Absent in the in-memory fuzz, for speed.
  projectRun?: (engine: any) => void;
  finishRun?: (engine: any) => void;
};

export type EngineOptions = {
  runId: string;
  spec: Spec;
  specSha: string;
  policySha: string;
};

export interface Publisher {
  freeze(ctx: PublishContext): Promise<{ sha: string }>;
  gates(
    ctx: PublishContext,
    sha: string,
  ): Promise<{
    ok: boolean;
    failures: { id: string; detail: string }[];
    results: Record<string, string>;
  }>;
  push(ctx: PublishContext, sha: string): Promise<{ ok: boolean; detail: string }>;
  verifyPush(
    ctx: PublishContext,
    sha: string,
  ): Promise<{ ok: boolean; detail: string; observed: string | null }>;
  remoteAt(ctx: PublishContext): Promise<string | null>;
  listPrs(
    ctx: PublishContext,
    sha: string,
  ): Promise<{ ok: boolean; prs: unknown[]; detail: string }>;
  openPr(
    ctx: PublishContext,
    sha: string,
  ): Promise<{ ok: boolean; url: string | null; detail: string }>;
  validatePr(
    ctx: PublishContext,
    sha: string,
    prs: unknown[],
  ): { ok: boolean; url: string | null; detail: string };
}

export type PublishContext = {
  runId: string;
  spec: Spec;
  branch: string;
  destination: string;
  candidate: string;
  reviewedTree: string;
  acceptedBase: string | null;
  prTitle: string;
  prBody: string;
};

// Thrown by a runner that stopped its command because the operator asked. Nothing from that gate run
// counts: no outcome is recorded, and it runs again if the run does.
export class GateStopped extends Error {}
