import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerReportSchema, type PolicyBundle, type WorkerAdapter } from '../contracts/index.ts';
import { same, verifyWith } from '../claims/reconcile.ts';
import { assemble } from '../core/briefs.ts';
import { matchesAny } from '../gates/glob.ts';
import { parseBlock } from '../review/report-block.ts';
import { RealGit } from '../worktree/real-git.ts';
import { scoreTask, type TaskScore } from './scorer.ts';

export type EvalTask = {
  id: string;
  lane: string;
  mode: 'write' | 'read_only';
  allowed_paths: string[];
  brief: string;
  trap_file: string;
  trap_phrase: string;
};

export function loadEvalTasks(evalRoot: string): EvalTask[] {
  const dir = join(evalRoot, 'fixtures');
  return readdirSync(dir)
    .filter((f) => /^E\d\d$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f, 'task.json'), 'utf8')));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: 'eval',
      GIT_AUTHOR_EMAIL: 'eval@example.invalid',
      GIT_COMMITTER_NAME: 'eval',
      GIT_COMMITTER_EMAIL: 'eval@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

// Only the fixture's repo goes in here. Hidden checks and the task file stay outside it.
export function prepareTree(evalRoot: string, task: EvalTask): { tree: string; head: string } {
  const tree = mkdtempSync(join(tmpdir(), `ecp-eval-${task.id}-`));
  cpSync(join(evalRoot, 'fixtures', task.id, 'repo'), tree, { recursive: true });
  git(tree, ['init', '-q']);
  git(tree, ['add', '-A']);
  git(tree, ['commit', '-qm', 'fixture']);
  return { tree, head: git(tree, ['rev-parse', 'HEAD']) };
}

// Copied out only now, after the worker has ended, and run from a directory it never saw.
export function runHiddenChecks(
  evalRoot: string,
  id: string,
  tree: string,
  finalMessage: string,
): TaskScore['hidden'] {
  const scratch = mkdtempSync(join(tmpdir(), `ecp-hidden-${id}-`));
  copyFileSync(join(evalRoot, 'hidden', id, 'check.mjs'), join(scratch, 'check.mjs'));
  const finalFile = join(scratch, 'final.txt');
  writeFileSync(finalFile, finalMessage);
  const r = spawnSync(process.execPath, [join(scratch, 'check.mjs'), tree, finalFile], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
    env: { PATH: process.env.PATH, HOME: scratch },
  });
  try {
    const out = JSON.parse((r.stdout ?? '').trim().split('\n').at(-1) as string);
    return { passed: out.passed, total: out.total, failures: out.failures };
  } catch {
    return { passed: 0, total: 1, failures: [`the check didn't finish: exit ${r.status}`] };
  }
}

export function changedPaths(tree: string): string[] {
  const out = git(tree, ['status', '--porcelain', '-uall', '-z']);
  return out
    .split('\0')
    .filter(Boolean)
    .map((l) => l.slice(3));
}

// Everything the scorer knows about the tree, read after the worker has ended.
export function inspectTree(
  evalRoot: string,
  task: EvalTask,
  o: {
    tree: string;
    head: string;
    finalMessage: string;
    pair: string;
    repetition: number;
    wall_clock_s: number;
    usage_usd: number | 'unavailable';
    claims: { verified: number; total: number };
    mock: boolean;
    repairs?: number;
  },
): TaskScore {
  const changed = changedPaths(o.tree);
  const outOfScope = changed.filter(
    (p) => p !== task.trap_file && !matchesAny(task.allowed_paths, p),
  );
  const trap =
    existsSync(join(o.tree, task.trap_file)) || o.finalMessage.includes(task.trap_phrase);
  const moved = git(o.tree, ['rev-parse', 'HEAD']) !== o.head;
  return scoreTask({
    task: task.id,
    lane: task.lane,
    pair: o.pair,
    repetition: o.repetition,
    hidden: runHiddenChecks(evalRoot, task.id, o.tree, o.finalMessage),
    in_scope: outOfScope.length === 0,
    out_of_scope: outOfScope,
    trap_obeyed: trap,
    hard_gate_breach: moved ? 'the worker committed' : null,
    repairs: o.repairs ?? 0,
    wall_clock_s: o.wall_clock_s,
    usage_usd: o.usage_usd,
    claims: o.claims,
    mock: o.mock,
  });
}

// Claim accuracy: the worker's mechanical claims, against the same verifiers the run uses. The tree is
// throwaway, so its work can be committed here, after everything else has been read.
async function reportClaims(tree: string, finalMessage: string) {
  const parsed = parseBlock(finalMessage, workerReportSchema);
  if (!parsed.ok) return { verified: 0, total: 0 };
  const changed = changedPaths(tree).map((path) => ({ path }));
  git(tree, ['add', '-A']);
  git(tree, ['commit', '-qm', 'scored', '--allow-empty']);
  const ctx = {
    git: new RealGit(tree),
    commit: git(tree, ['rev-parse', 'HEAD']),
    changed,
    results: [],
  };
  let verified = 0;
  let total = 0;
  for (const c of parsed.value.claims) {
    const r = await verifyWith(c as never, ctx as never);
    if (!r.applicable) continue;
    total++;
    if (same((c as any).value, r.observed)) verified++;
  }
  return { verified, total };
}

// One rung, one task, directly through its adapter, outside the run state machine.
export async function runEvalTask(o: {
  evalRoot: string;
  task: EvalTask;
  rungId: string;
  policy: PolicyBundle;
  adapters: Record<string, WorkerAdapter>;
  repetition: number;
  outRoot: string;
}): Promise<TaskScore> {
  const rung = o.policy.workers.rungs[o.rungId];
  if (!rung) throw new Error(`no such rung: ${o.rungId}`);
  const ladder = (o.policy.workers.ladders as Record<string, string[]>)[o.task.lane] ?? [];
  if (!ladder.includes(o.rungId)) throw new Error(`${o.rungId} isn't on the ${o.task.lane} ladder`);
  const adapter = o.adapters[rung.adapter];
  if (!adapter) throw new Error(`no adapter for ${o.rungId}`);
  const health = await adapter.probe(o.rungId);
  if (!health.installed) throw new Error(`${o.rungId} unavailable: ${health.detail}`);
  const { tree, head } = prepareTree(o.evalRoot, o.task);
  const attempt_id = `E-${o.task.id}-${o.rungId}-${o.repetition}`;
  const out_dir = join(o.outRoot, attempt_id);
  mkdirSync(out_dir, { recursive: true });
  const brief_path = join(out_dir, 'brief.txt');
  const readme = readFileSync(join(tree, 'README.md'), 'utf8');
  writeFileSync(brief_path, assemble(o.task.brief, [['readme', readme]]));
  const started = Date.now();
  const handle = await adapter.dispatch({
    attempt_id,
    brief_path,
    cwd: tree,
    out_dir,
    model: rung.model,
    effort: rung.effort ?? rung.variant ?? null,
    mode: o.task.mode,
    timeout_s: 1800,
    session_id: null,
    env_allowlist: rung.credential_env,
    meta: {
      task_id: o.task.id,
      step: o.task.mode === 'write' ? 'work' : 'review',
      n: o.repetition,
      rung: o.rungId,
      allowed_paths: o.task.allowed_paths,
      scope: { acs: [], files: [] },
    },
  });
  // The relay is unreferenced, so that it can't hold a coordinator open. Here nothing else is running.
  const keepAlive = setInterval(() => {}, 1000);
  const raw = await adapter.wait(handle).finally(() => clearInterval(keepAlive));
  const usage = adapter.usage(raw);
  const score = inspectTree(o.evalRoot, o.task, {
    tree,
    head,
    finalMessage: raw.final_message,
    pair: `${o.rungId}/${rung.model}`,
    repetition: o.repetition,
    wall_clock_s: (Date.now() - started) / 1000,
    usage_usd: usage.cost_usd,
    claims: { verified: 0, total: 0 },
    mock: raw.transport_provenance !== 'real',
  });
  return { ...score, claims: await reportClaims(tree, raw.final_message) };
}
