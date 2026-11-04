import type { Engine } from './engine.ts';
import { InvariantViolation, type TaskRec } from './reducer.ts';
import { lastSnapshot } from './selectors.ts';
import { stepTasks } from './steps-task.ts';
import { topoOrder } from './plan-validate.ts';

export function integrationBranch(e: Engine) {
  return `refs/heads/ecp/${e.o.runId}/integration`;
}
export function tipOf(e: Engine): string {
  return e.s.integration.tip ?? e.spec.target.base_commit;
}

export function unionPaths(e: Engine): string[] {
  const out = new Set<string>();
  for (const t of Object.values(e.s.tasks)) for (const p of t.spec.allowed_paths) out.add(p);
  return [...out];
}

export function openIntegrationTask(
  e: Engine,
  entry: 'READY' | 'REPAIR_PENDING' | 'CHALLENGE_PENDING' | 'TASK_DISAGREEMENT',
  o: {
    conflict_of?: string;
    findings?: unknown[];
    gate_runs?: unknown[];
    charge?: boolean;
    note?: string;
    snapshot0?: Record<string, unknown>;
    next_step?: string;
    from_retry?: boolean;
  } = {},
): TaskRec {
  const id = `T-INT-${e.s.next_tint}`;
  e.append('task.state_changed', id, {
    from: null,
    to: entry,
    is_integration: true,
    spec: {
      goal: o.conflict_of
        ? `Resolve the merge conflict with ${o.conflict_of}`
        : 'Repair the integrated candidate',
      lane: 'integration-repair',
      allowed_paths: unionPaths(e),
      forbidden_paths: [],
      acceptance_criteria: e.spec.acceptance_criteria
        .filter((c) => !c.human_reserved)
        .map((c) => c.id),
      required_tests: e.spec.required_tests.map((t) => t.id),
      depends_on: [],
    },
    base_commit: tipOf(e),
    conflict_of: o.conflict_of ?? null,
    open_findings: o.findings ?? [],
    gate_runs: o.gate_runs ?? [],
    charge: o.charge,
    note: o.note ?? null,
    snapshot0: o.snapshot0,
    from_retry: o.from_retry,
    next_step:
      o.next_step ??
      (entry === 'REPAIR_PENDING'
        ? 'repair'
        : entry === 'CHALLENGE_PENDING'
          ? 'challenge'
          : entry === 'TASK_DISAGREEMENT'
            ? 'adjudicate'
            : 'work'),
  });
  return e.s.tasks[id];
}

// A passed T-INT lands on the integration branch; a conflict one gets both parents.
export async function completeIntegrationTask(e: Engine, t: TaskRec): Promise<boolean> {
  const snap = lastSnapshot(t);
  if (!snap) throw new InvariantViolation(`${t.task_id} has no snapshot`);
  const tip = tipOf(e);
  const conflictCommit = t.conflict_of ? e.s.tasks[t.conflict_of].commit : null;
  const parents = conflictCommit ? [tip, conflictCommit] : [tip];
  e.append('merge.intent', t.task_id, { tree: snap.tree, task: t.task_id, parents });
  const commit = await e.p.git.commitTree(
    snap.tree,
    parents,
    `${t.task_id}: ${t.spec.goal}\n\nSpec: ${e.spec.spec_id}\nRun: ${e.o.runId}\n`,
  );
  if ((await e.p.git.treeOf(commit)) !== snap.tree)
    throw new InvariantViolation('H-TREE-ID at integration commit');
  await e.p.git.updateRef(integrationBranch(e), commit);
  e.append('merge.done', t.task_id, {
    tip: commit,
    branch: integrationBranch(e),
    task_id: t.conflict_of ?? undefined,
    authors: t.retained_families,
  });
  e.taskTo(e.s.tasks[t.task_id], 'TASK_PASSED', 'review_passed', { commit });
  return true;
}

async function mergeNext(e: Engine, id: string): Promise<boolean> {
  const t = e.s.tasks[id];
  const tip = tipOf(e);
  const commit = t.commit as string;
  e.append('merge.intent', id, { task: id, tip });
  const merged = await e.p.git.mergeTrees(tip, commit);
  if (merged.clean) {
    const mergeCommit = await e.p.git.commitTree(merged.tree, [tip, commit], `Merge ${id}`);
    await e.p.git.updateRef(integrationBranch(e), mergeCommit);
    e.append('merge.done', id, {
      tip: mergeCommit,
      branch: integrationBranch(e),
      task_id: id,
      authors: t.retained_families,
    });
    return true;
  }
  e.append('merge.conflict', id, { conflicted: merged.conflicted });
  const quick = e.s.depth === 'QUICK';
  if (quick || e.s.conflict_attempts >= 1) {
    e.escalate(
      'MERGE_CONFLICT',
      null,
      `merging ${id}: ${merged.conflicted.join(', ')}`,
      'merge_conflict',
    );
    return true;
  }
  // Snapshot 0 holds the tree with its markers, and has no author. It's the reset point.
  const snapCommit = await e.p.git.commitTree(merged.tree, [tip], `Conflict markers for ${id}`);
  const n = e.s.next_tint;
  const ref = `refs/ecp/${e.o.runId}/T-INT-${n}/0`;
  await e.p.git.updateRef(ref, snapCommit);
  openIntegrationTask(e, 'READY', {
    conflict_of: id,
    charge: false,
    snapshot0: {
      n: 0,
      ref,
      commit: snapCommit,
      tree: merged.tree,
      family: null,
      rung: null,
      claims: [],
      disputes: [],
    },
  });
  return true;
}

export async function stepIntegrating(e: Engine): Promise<boolean> {
  if (e.s.pending_retry_integration !== null) {
    openIntegrationTask(e, 'READY', {
      note: e.s.pending_retry_integration,
      charge: false,
      from_retry: true,
    });
    return true;
  }
  if (await stepTasks(e)) return true;
  const tasks = Object.values(e.s.tasks);
  const open = tasks.filter(
    (t) => t.is_integration && !['TASK_PASSED', 'TASK_CANCELLED'].includes(t.state),
  );
  if (open.length) return e.pauseIfStuck();
  if (e.anyInflight()) return false;
  const regular = tasks.filter((t) => !t.is_integration);
  // Risk may have reopened a task: it passes again before it merges.
  if (regular.some((t) => t.state !== 'TASK_PASSED')) return e.pauseIfStuck();
  const order = topoOrder(
    regular.map((t) => ({ task_id: t.task_id, depends_on: t.spec.depends_on })),
  );
  for (const id of order) {
    if (!e.s.integration.merged.includes(id)) return mergeNext(e, id);
  }
  e.runTo('VERIFYING', 'merges_done');
  return true;
}
