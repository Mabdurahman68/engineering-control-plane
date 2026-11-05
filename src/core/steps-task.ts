import { challengeSchema, rulingSchema, workerReportSchema } from '../contracts/index.ts';
import type { FailureClass, WorkerReport } from '../contracts/index.ts';
import { reconcileClaims } from '../claims/reconcile.ts';
import { checkEvidence, checkReview, checkTreeId } from '../gates/checks.ts';
import { type GateResult, runGates } from '../gates/gates.ts';
import { sha256 } from '../ledger/canonical.ts';
import { ruleRisk } from '../policy/risk.ts';
import { parseBlock } from '../review/report-block.ts';
import { stallSignal } from '../repair/stall.ts';
import { assemble, repairBriefFor, specExcerpt } from './briefs.ts';
import { type Engine, gateWaiver } from './engine.ts';
import { InvariantViolation, type AttemptRec, type TaskRec } from './reducer.ts';
import {
  authorsOfTask,
  currentAttempt,
  lastSnapshot,
  openWriters,
  resetPoint,
} from './selectors.ts';
import { sweepAttempt } from './recovery.ts';
import {
  awaitReadStep,
  collectReview,
  failReadStep,
  holdFor,
  reviewSpecSha,
  skipListFor,
} from './steps-review.ts';
import { completeIntegrationTask } from './steps-integrate.ts';

function ladderOf(e: Engine, t: TaskRec): string[] {
  return e.p.policy.workers.ladders[t.spec.lane as 'implementation'];
}

export async function stepTasks(e: Engine): Promise<boolean> {
  let progressed = false;
  for (const id of [...e.s.task_order]) {
    const t = e.s.tasks[id];
    if (await stepTask(e, t)) progressed = true;
    // A state change this tick could stop the run; don't start anything else if so.
    if (e.s.pending_request) break;
  }
  return progressed;
}

async function stepTask(e: Engine, t: TaskRec): Promise<boolean> {
  switch (t.state) {
    case 'PENDING': {
      const deps = t.spec.depends_on.map((d) => e.s.tasks[d]);
      if (deps.some((d) => d?.state === 'TASK_ESCALATED' || d?.state === 'TASK_BLOCKED')) {
        e.taskTo(t, 'TASK_BLOCKED', 'dep_failed');
        return true;
      }
      if (deps.every((d) => d?.state === 'TASK_PASSED')) {
        e.taskTo(t, 'READY', 'deps_passed');
        return true;
      }
      return false;
    }
    case 'TASK_BLOCKED':
      if (t.spec.depends_on.every((d) => e.s.tasks[d]?.state === 'TASK_PASSED')) {
        e.taskTo(t, 'READY', 'unblocked');
        return true;
      }
      return false;
    case 'READY':
      return stepReady(e, t);
    case 'DISPATCHING':
      return stepDispatching(e, t);
    case 'WORKING':
      return stepWorking(e, t);
    case 'COLLECTING':
      return stepCollecting(e, t);
    case 'GATING':
      return stepGating(e, t);
    case 'CHALLENGE_PENDING':
      return stepChallenge(e, t);
    case 'REVIEWING':
      return stepReviewing(e, t);
    case 'REPAIR_PENDING':
      return stepRepairPending(e, t);
    case 'TASK_DISAGREEMENT':
      return stepDisagreement(e, t);
    case 'TASK_WAITING_WORKER':
      return stepWaiting(e, t);
    case 'TASK_PASSED':
      // After a risk rise, work that isn't merged is held to the stricter profile.
      if (
        !t.is_integration &&
        t.passed_risk !== e.s.risk &&
        !e.s.integration.merged.includes(t.task_id)
      ) {
        e.taskTo(t, 'REVIEWING', 'risk_raised', { next_step: 'review' });
        return true;
      }
      return false;
    default:
      return false;
  }
}

async function baseFor(e: Engine, t: TaskRec): Promise<{ base: string } | { conflict: true }> {
  if (t.base_commit && t.is_integration) return { base: t.base_commit };
  const deps = t.spec.depends_on.map((d) => e.s.tasks[d]);
  if (deps.length === 0) return { base: e.spec.target.base_commit };
  if (deps.length === 1) return { base: deps[0].commit as string };
  let current = deps[0].commit as string;
  for (const dep of deps.slice(1)) {
    const merged = await e.p.git.mergeTrees(current, dep.commit as string);
    if (!merged.clean) return { conflict: true };
    current = await e.p.git.commitTree(
      merged.tree,
      [current, dep.commit as string],
      `Synthetic base for ${t.task_id}`,
    );
  }
  return { base: current };
}

async function stepReady(e: Engine, t: TaskRec): Promise<boolean> {
  if (Object.values(e.s.tasks).some((x) => x.state === 'TASK_ESCALATED')) return false;
  if (openWriters(e.s) >= effectiveWriters(e)) return false;
  if (!t.worktree || t.needs_reset) {
    const b = await baseFor(e, t);
    if ('conflict' in b) {
      e.decide('DP-ESCALATE', t, 'escalate', 'MERGE_CONFLICT', t.state, 'TASK_ESCALATED');
      e.taskTo(t, 'TASK_ESCALATED', 'synthetic_conflict', {
        escalation_reason: 'SYNTHETIC_MERGE_CONFLICT',
      });
      return true;
    }
    await ensureWorktree(e, t, b.base);
  }
  const ladder = ladderOf(e, t);
  await e.refreshHealth(ladder);
  const skip = skipListFor(e, t, t.next_step === 'repair' ? 'repair' : 'work');
  const rung = e.pickWriter(ladder, skip, t.rung);
  if (!rung) {
    e.taskTo(t, 'TASK_WAITING_WORKER', 'no_rung', {
      next_step: t.next_step === 'repair' ? 'repair' : 'work',
    });
    return true;
  }
  e.taskTo(t, 'DISPATCHING', 'dispatch', { rung });
  return dispatchWorker(e, t, rung);
}

function effectiveWriters(e: Engine): number {
  return e.profile().parallel_writers;
}

export async function ensureWorktree(e: Engine, t: TaskRec, base: string) {
  const gen = t.worktree_gen + 1;
  const path = e.p.paths.worktree(e.o.runId, t.task_id, gen);
  await e.p.git.removeWorktree(path);
  if (t.worktree) await e.p.git.removeWorktree(t.worktree);
  await e.p.git.addWorktree(path, null, base);
  e.append('worktree.created', t.task_id, { path, base_commit: base });
  const point = resetPoint(e.s.tasks[t.task_id]);
  if (point !== base) await e.p.git.resetWorktree(path, point);
}

async function prepareForDispatch(e: Engine, t: TaskRec) {
  if (!t.worktree) await ensureWorktree(e, t, t.base_commit ?? e.spec.target.base_commit);
  else if (!t.keep_diff) await e.p.git.resetWorktree(t.worktree, resetPoint(t));
}

async function stepDispatching(e: Engine, t: TaskRec): Promise<boolean> {
  const open = currentAttempt(e.s, t.task_id, ['work', 'repair']);
  if (open) {
    if (open.finished) {
      // Recovery found the relay lost during the spawn window.
      e.taskTo(t, 'COLLECTING', 'spawn_failed');
      return true;
    }
    if (open.started) {
      e.taskTo(t, 'WORKING', 'started');
      return true;
    }
    if (e.outcomeOf(open.attempt_id)?.spawn_failed) {
      e.recordFinish(open, e.outcomeOf(open.attempt_id) as never);
      e.taskTo(t, 'COLLECTING', 'spawn_failed');
      return true;
    }
    return false;
  }
  const step = t.next_step === 'repair' ? 'repair' : 'work';
  const hold = holdFor(e, t, step);
  if (hold?.waiting) return false;
  if (e.draining) return false;
  const ladder = ladderOf(e, t);
  await e.refreshHealth(ladder);
  const rung = hold ? hold.rung : e.pickWriter(ladder, skipListFor(e, t, step), t.rung);
  if (!rung) {
    e.taskTo(t, 'COLLECTING', 'spawn_failed');
    e.taskTo(t, 'TASK_WAITING_WORKER', 'failure_no_rung', { next_step: step });
    return true;
  }
  return dispatchWorker(e, t, rung);
}

async function dispatchWorker(e: Engine, t: TaskRec, rung: string): Promise<boolean> {
  if (e.capBlocks()) return false;
  await prepareForDispatch(e, t);
  const fresh = e.s.tasks[t.task_id];
  // Between the prepare's await and here, another task may have reserved a family.
  const { rungWouldStrandReview } = await import('./selectors.ts');
  if (rungWouldStrandReview(e.s, e.p.policy, rung)) {
    e.taskTo(fresh, 'COLLECTING', 'spawn_failed');
    e.taskTo(fresh, 'TASK_WAITING_WORKER', 'failure_no_rung', {
      next_step: fresh.next_step === 'repair' ? 'repair' : 'work',
    });
    return true;
  }
  const step = fresh.next_step === 'repair' ? 'repair' : 'work';
  const brief = assemble(e.p.prompts[step] ?? '', [
    ['spec', specExcerpt(e.spec)],
    ['task', { task_id: fresh.task_id, ...fresh.spec }],
    ['base_commit', fresh.base_commit],
    ...(step === 'repair'
      ? ([
          [
            'repair_brief',
            repairBriefFor(
              fresh.attempts + 1,
              fresh.open_findings as never[],
              fresh.gate_runs,
              [],
              fresh.spec.allowed_paths,
            ),
          ],
        ] as [string, unknown][])
      : []),
    ...(fresh.note ? ([['owner_note', fresh.note]] as [string, unknown][]) : []),
  ]);
  const a = e.beginAttempt({
    task: fresh,
    step,
    rung,
    mode: 'write',
    cwd: fresh.worktree as string,
    brief,
    n: fresh.attempts + 1,
    intent: 'dispatch.intent',
  });
  const prev = Object.values(e.s.attempts)
    .filter((x) => x.task_id === t.task_id && x.step === step && x.attempt_id !== a.attempt_id)
    .pop();
  const session = fresh.keep_diff && prev ? (e.loadRaw(prev)?.session_id ?? null) : null;
  await e.spawnAttempt(
    a,
    { acs: fresh.spec.acceptance_criteria, files: [] },
    fresh.spec.allowed_paths,
    session,
  );
  const after = e.s.tasks[t.task_id];
  if (a.started || e.s.attempts[a.attempt_id].started) {
    e.taskTo(after, 'WORKING', 'started');
  }
  return true;
}

async function stepWorking(e: Engine, t: TaskRec): Promise<boolean> {
  const a = currentAttempt(e.s, t.task_id, ['work', 'repair']);
  if (!a) {
    e.taskTo(t, 'COLLECTING', 'relay_exited');
    return true;
  }
  if (a.finished) {
    e.taskTo(t, 'COLLECTING', 'relay_exited');
    return true;
  }
  const raw = e.outcomeOf(a.attempt_id);
  if (!raw) return false;
  e.recordFinish(a, raw);
  e.taskTo(t, 'COLLECTING', 'relay_exited');
  return true;
}

function latestWorkAttempt(e: Engine, t: TaskRec): AttemptRec | null {
  return currentAttempt(e.s, t.task_id, ['work', 'repair']);
}

async function stepCollecting(e: Engine, t: TaskRec): Promise<boolean> {
  const a = latestWorkAttempt(e, t);
  if (!a) {
    // Classified, and the crash fell before the transition. A retained result goes on to its gates.
    const last = Object.values(e.s.attempts)
      .filter((x) => x.task_id === t.task_id && x.mode === 'write')
      .pop();
    if (last?.class === 'OK' && last.retained) {
      e.taskTo(t, 'GATING', 'report_valid', { next_step: 'gate' });
      return true;
    }
    e.taskTo(t, 'DISPATCHING', 'failure_rung_available');
    return true;
  }
  const raw = e.loadRaw(a);
  if (!raw) throw new InvariantViolation(`attempt ${a.attempt_id} has no outcome`);
  await sweepAttempt(e, a);
  e.checkSpecLock();
  let cls: FailureClass = raw.spawn_failed ? 'UNKNOWN' : e.classifyRaw(a, raw);
  let report: WorkerReport | null = null;
  if (cls === 'OK') {
    const parsed = parseBlock(raw.final_message, workerReportSchema);
    if (parsed.ok) report = parsed.value;
    else cls = 'MALFORMED';
  }
  if (cls === 'OK') return recordSnapshot(e, t, a, report as WorkerReport, raw);
  return handleWorkerFailure(e, t, a, cls);
}

async function recordSnapshot(
  e: Engine,
  t: TaskRec,
  a: AttemptRec,
  report: WorkerReport,
  raw: any,
): Promise<boolean> {
  // The finished, unclassified attempt is the durable intent. A crash here redoes this idempotently,
  // on the untouched tree, because no attempt can start until this one is classified.
  if (a.retained) {
    e.append('dispatch.classified', t.task_id, {
      attempt_id: a.attempt_id,
      class: 'OK',
      rejected_disputes: 0,
    });
    e.taskTo(t, 'GATING', 'report_valid', { next_step: 'gate' });
    return true;
  }
  const n = t.snapshots.length + 1;
  const ref = `refs/ecp/${e.o.runId}/${t.task_id}/${n}`;
  const parent = resetPoint(t);
  const { commit, tree } = await e.p.git.snapshot(
    t.worktree as string,
    ref,
    parent,
    `snapshot ${t.task_id} ${n}`,
  );
  e.p.store.write(`attempts/${a.attempt_id}/final.txt`, raw.final_message);
  // A dispute is only for a finding in this worker's own brief, with evidence, not yet adjudicated.
  const own = new Set((t.open_findings as any[]).map((f) => f.fingerprint));
  const disputes = report.disputed_findings.filter((d) => {
    const okEvidence = d.evidence.length > 0;
    const allowed =
      a.step === 'repair' && own.has(d.fingerprint) && !t.adjudicated.includes(d.fingerprint);
    return okEvidence && allowed;
  });
  e.append('snapshot.recorded', t.task_id, {
    n,
    ref,
    commit,
    tree,
    family: a.family,
    rung: a.rung,
    attempt_id: a.attempt_id,
    claims: report.claims,
    disputes,
    tests_run_claimed: report.tests_run_claimed,
    known_issues: report.known_issues,
    status: report.status,
    usage_session: raw.session_id ?? null,
  });
  e.append('dispatch.classified', t.task_id, {
    attempt_id: a.attempt_id,
    class: 'OK',
    rejected_disputes: report.disputed_findings.length - disputes.length,
  });
  e.taskTo(t, 'GATING', 'report_valid', { next_step: 'gate' });
  return true;
}

function handleWorkerFailure(e: Engine, t: TaskRec, a: AttemptRec, cls: FailureClass): boolean {
  if (cls === 'CANCELLED') {
    e.append('dispatch.classified', t.task_id, { attempt_id: a.attempt_id, class: cls });
    e.releaseIfUnretained(a);
    e.taskTo(t, 'TASK_WAITING_WORKER', 'pausing', {
      next_step: t.next_step === 'repair' ? 'repair' : 'work',
    });
    return true;
  }
  const step = a.step;
  const key = `${step}:${a.rung}:${cls}`;
  const seen = t.rung_retries[key] ?? 0;
  if (cls === 'TIMEOUT') {
    const rungs = new Set(
      Object.values(e.s.attempts)
        .filter((x) => x.task_id === t.task_id && (x.class === 'TIMEOUT' || x === a))
        .map((x) => x.rung),
    );
    if (rungs.size >= 2) {
      e.append('dispatch.classified', t.task_id, { attempt_id: a.attempt_id, class: cls });
      e.releaseIfUnretained(a);
      e.taskTo(t, 'REPAIR_PENDING', 'second_timeout', {
        next_step: 'repair',
        forced_stall: 'second_timeout',
      });
      return true;
    }
  }
  const plan = e.planFailure(cls, a, seen, null);
  if (plan.salvage && t.worktree) {
    e.p.store.write(`salvage/${t.task_id}-${a.n}.patch.intent`, a.attempt_id);
    e.append('worktree.salvaged', t.task_id, {
      attempt_id: a.attempt_id,
      new_dir: true,
      path: `salvage/${t.task_id}-${a.n}.patch`,
      old: t.worktree,
    });
  }
  const ladder = ladderOf(e, t);
  const skip = [...skipListFor(e, t, step), ...(plan.retry_same ? [] : [a.rung])];
  const next = plan.retry_same ? a.rung : pickAfterFailure(e, ladder, skip, a.rung, plan);
  const action = plan.retry_same ? 'retry_same_rung' : next ? 'next_rung' : 'wait';
  e.decide(
    'DP-FALLBACK',
    t,
    action,
    next,
    'COLLECTING',
    next ? 'DISPATCHING' : 'TASK_WAITING_WORKER',
  );
  if (!e.s.attempts[a.attempt_id].fallback_applied)
    e.applyFailurePlan(a, cls, plan, key, next, plan.keep_diff);
  e.releaseIfUnretained(a);
  e.append('dispatch.classified', t.task_id, { attempt_id: a.attempt_id, class: cls });
  if (next) {
    e.taskTo(t, 'DISPATCHING', cls === 'MALFORMED' ? 'malformed' : 'failure_rung_available', {
      rung: next,
    });
  } else {
    e.taskTo(t, 'TASK_WAITING_WORKER', 'failure_no_rung', {
      next_step: step === 'repair' ? 'repair' : 'work',
    });
  }
  return true;
}

function pickAfterFailure(
  e: Engine,
  ladder: string[],
  skip: string[],
  failed: string,
  plan: { backoff_until: number | null; quarantine_until: unknown },
): string | null {
  // The rung's own backoff or quarantine isn't on record yet, so skip it explicitly.
  void plan;
  return e.pickWriter(
    ladder.filter((r) => r !== failed),
    skip,
    null,
  );
}

// --- Gating ----------------------------------------------------------------------------------------

function lineageOf(e: Engine, t: TaskRec, seen = new Set<string>()): Set<string> {
  if (seen.has(t.task_id)) return seen;
  seen.add(t.task_id);
  for (const d of t.spec.depends_on) if (e.s.tasks[d]) lineageOf(e, e.s.tasks[d], seen);
  return seen;
}

// A waiver covers this task and any task built on the one it was ruled for: the same failure, from
// the same code. It's matched by signature element all the same.
function gateWaiversFor(e: Engine, t: TaskRec) {
  const lineage = lineageOf(e, t);
  return e.s.waivers
    .filter((w: any) => w.kind === 'gate' && lineage.has(w.scope))
    .map((w: any) => ({
      gate_id: w.resolves.gate_id,
      signature_element: w.resolves.signature_element,
    }));
}

export function trimResults(results: GateResult[]) {
  return results.map((r) => ({
    id: r.id,
    status: r.status,
    soft: r.soft,
    signature: r.signature,
    elements: r.elements,
    uncovered: r.uncovered,
    detail: r.detail,
    command: r.command,
    exit: r.exit,
    log_sha: r.log_sha,
    log_path: r.log_path,
    tree_hash: r.tree_hash,
    normalised: r.normalised,
  }));
}

// The rule that raises risk runs on the changed files as soon as the gate run is on the ledger.
function applyDiffRisk(e: Engine, t: TaskRec, changed: { path: string }[]) {
  e.raiseRisk(
    ruleRisk(
      e.p.policy.riskRules,
      changed.map((f) => f.path),
    ),
    `diff of ${t.task_id}`,
  );
}

async function stepGating(e: Engine, t: TaskRec): Promise<boolean> {
  if (e.draining) return false;
  const snap = lastSnapshot(t);
  if (!snap) throw new InvariantViolation(`${t.task_id} reached GATING with no snapshot`);
  const { git, runner, store } = e.p;
  const checkout = e.p.paths.checkout(e.o.runId, `gate-${t.task_id}-${snap.n}`);
  await git.removeWorktree(checkout);
  await git.addWorktree(checkout, null, snap.commit);
  e.append('gate.intent', t.task_id, { n: snap.n, tree: snap.tree });
  const requiredTests = e.spec.required_tests.filter((x) => t.spec.required_tests.includes(x.id));
  const base = t.base_commit as string;
  const profile = e.profile();
  const attempt = Object.values(e.s.attempts)
    .filter((a) => a.task_id === t.task_id && a.mode === 'write')
    .pop();
  const rawFinal = attempt ? e.loadRaw(attempt) : null;
  const artifactTexts = rawFinal
    ? [
        { name: 'final', text: rawFinal.final_message },
        { name: 'stderr', text: rawFinal.stderr_tail },
      ]
    : [];
  const report = { claims: snap.claims as never, tests_run_claimed: [] as string[] };
  const out = await runGates({
    git,
    runner,
    store,
    spec: e.spec,
    subject: t.task_id,
    attemptN: snap.n,
    allowed: t.spec.allowed_paths,
    forbidden: t.spec.forbidden_paths,
    base,
    commit: snap.commit,
    tree: snap.tree,
    checkout,
    requiredTests,
    requiredTestIds: t.spec.required_tests,
    runFull: profile.task_tests === 'required_and_full',
    fullRuns: 1,
    baselineFullSignature: e.s.baseline_signature,
    secretPatterns: e.secret,
    waivers: gateWaiversFor(e, t),
    worker:
      t.worktree && snap.family
        ? {
            worktree: t.worktree,
            expectedHead: base,
            configBaseline: e.s.config_baseline as string,
            artifactTexts,
          }
        : undefined,
    claims: async (results, changed) => {
      const rec = await reconcileClaims({
        taskId: t.task_id,
        attempt: snap.n,
        rung: snap.rung ?? 'code',
        spec: e.spec,
        requiredTests: t.spec.required_tests,
        report,
        includeWorkerClaims: profile.claim_ledger !== 'required_only',
        git,
        commit: snap.commit,
        changed,
        results,
      });
      for (const c of rec.claims) e.append('claim.recorded', t.task_id, { claim: c });
      e.append('claim.reconciled', t.task_id, { ok: rec.ok, detail: rec.detail, attempt: snap.n });
      store.write(`claims/${t.task_id}-${snap.n}.json`, JSON.stringify(rec.claims, null, 2));
      return { ok: rec.ok, detail: rec.detail };
    },
  });
  await git.removeWorktree(checkout);
  e.append('gate.finished', t.task_id, {
    tree: snap.tree,
    attempt_n: snap.n,
    classification: out.classification,
    results: trimResults(out.results),
    changed: out.changed,
  });
  applyDiffRisk(e, t, out.changed);
  const fresh = e.s.tasks[t.task_id];
  const failed = out.results.filter((r) => r.status === 'FAIL');
  const refs = { signatures: failed.map((r) => r.signature ?? r.id) };
  switch (out.classification) {
    case 'tree_changed':
      e.append('evidence.discarded_stale', t.task_id, {
        tree: snap.tree,
        changed: out.tree_changed,
      });
      e.append('gate.finished', t.task_id, {
        tree: snap.tree,
        attempt_n: snap.n,
        classification: out.classification,
        results: trimResults(
          out.results
            .filter((r) => r.id === 'H-TREE-ID')
            .map((r) => ({
              ...r,
              detail: `a gate changed: ${(out.tree_changed ?? []).join(', ')}`,
            })),
        ),
      });
      e.decide(
        'DP-GATES',
        fresh,
        'repair',
        fresh.task_id,
        'GATING',
        'REPAIR_PENDING',
        refs,
        snap.tree,
      );
      e.taskTo(fresh, 'REPAIR_PENDING', 'tree_changed', { next_step: 'repair' });
      return true;
    case 'hard_nonrepairable':
      e.decide(
        'DP-GATES',
        fresh,
        'escalate',
        fresh.task_id,
        'GATING',
        'TASK_ESCALATED',
        refs,
        snap.tree,
      );
      e.decide(
        'DP-ESCALATE',
        fresh,
        'escalate',
        'HARD_GATE_BREACH',
        'GATING',
        'TASK_ESCALATED',
        refs,
        snap.tree,
      );
      e.taskTo(fresh, 'TASK_ESCALATED', 'hard_nonrepairable', {
        escalation_reason: 'HARD_GATE_BREACH',
      });
      return true;
    case 'hard_repairable':
      e.decide(
        'DP-GATES',
        fresh,
        'repair',
        fresh.task_id,
        'GATING',
        'REPAIR_PENDING',
        refs,
        snap.tree,
      );
      e.taskTo(fresh, 'REPAIR_PENDING', 'hard_repairable', { next_step: 'repair' });
      return true;
    case 'soft_failed':
      e.decide(
        'DP-GATES',
        fresh,
        'request_challenge',
        fresh.task_id,
        'GATING',
        'CHALLENGE_PENDING',
        refs,
        snap.tree,
      );
      e.taskTo(fresh, 'CHALLENGE_PENDING', 'soft_failed', { next_step: 'challenge' });
      return true;
    default:
      break;
  }
  if ((snap.disputes as any[]).length > 0) {
    for (const d of snap.disputes as any[]) {
      openDisagreement(e, fresh, {
        kind: 'MECHANICAL_PASS_SEMANTIC_FAIL',
        gate_id: null,
        review_id: fresh.reviews[fresh.reviews.length - 1]?.review_id ?? null,
        code_result: 'PASS',
        agent_position: 'FINDING_DISPUTED',
        filed_by: snap.rung ?? 'code',
        reason: d.reason,
        requested_action: 'OVERRIDE_FINDING',
        keys: [d.fingerprint],
      });
    }
    e.decide(
      'DP-GATES',
      fresh,
      'adjudicate',
      fresh.task_id,
      'GATING',
      'TASK_DISAGREEMENT',
      refs,
      snap.tree,
    );
    e.taskTo(fresh, 'TASK_DISAGREEMENT', 'dispute_open', { next_step: 'adjudicate' });
    return true;
  }
  e.decide(
    'DP-GATES',
    fresh,
    'proceed_to_review',
    fresh.task_id,
    'GATING',
    'REVIEWING',
    refs,
    snap.tree,
  );
  e.taskTo(fresh, 'REVIEWING', 'gates_passed', { next_step: 'review' });
  return true;
}

export function openDisagreement(
  e: Engine,
  t: TaskRec,
  o: {
    kind: string;
    gate_id: string | null;
    review_id: string | null;
    code_result: 'PASS' | 'FAIL';
    agent_position: string;
    filed_by: string;
    reason: string;
    requested_action: 'WAIVE' | 'OVERRIDE_FINDING' | 'REPAIR';
    keys?: string[];
    elements?: string[];
    status?: string;
  },
) {
  // A crash can re-run the step that opened this. One record per identity.
  const existing = (o.keys ?? []).length
    ? Object.values<any>(e.s.disagreements).find(
        (x) => x.subject.task_id === t.task_id && JSON.stringify(x.keys) === JSON.stringify(o.keys),
      )
    : Object.values<any>(e.s.disagreements).find(
        (x) =>
          x.subject.task_id === t.task_id &&
          x.subject.review_id !== null &&
          x.subject.review_id === o.review_id &&
          x.kind === o.kind,
      );
  if (existing) return existing.id;
  const id = `D-${Object.keys(e.s.disagreements).length + 1}`;
  const record = {
    schema: 'disagreement.v1',
    id,
    kind: o.kind,
    subject: { task_id: t.task_id, gate_id: o.gate_id, review_id: o.review_id },
    code_result: o.code_result,
    agent_position: o.agent_position,
    filed_by: o.filed_by,
    reason: o.reason,
    evidence: [],
    requested_action: o.requested_action,
    adjudication: {
      status: o.status ?? 'PENDING',
      adjudicator: o.status === 'ROUTED_TO_REPAIR' ? 'policy' : null,
      reason: null,
      evidence: [],
      decided_at: null,
    },
    keys: o.keys ?? [],
    elements: o.elements ?? [],
  };
  e.append('disagreement.opened', t.task_id, { record });
  e.p.store.write(`disagreements/${id}.json`, JSON.stringify(record, null, 2));
  return id;
}

// --- Challenge -------------------------------------------------------------------------------------

function failedSoftGates(t: TaskRec) {
  const run = t.gate_runs[t.gate_runs.length - 1];
  return (run?.results ?? []).filter((r: any) => r.soft && r.status === 'FAIL') as any[];
}

function filerRung(e: Engine, t: TaskRec): string | null {
  if (t.is_integration) {
    const auth = e.authorsIntegrated();
    return (
      e.p.policy.workers.ladders['integration-repair'].find(
        (r) => auth.includes(e.family(r)) && e.rungAvailable(r),
      ) ?? null
    );
  }
  const snap = lastSnapshot(t);
  const rung = snap?.rung ?? t.rung;
  return rung && e.rungAvailable(rung) ? rung : null;
}

async function stepChallenge(e: Engine, t: TaskRec): Promise<boolean> {
  const a = currentAttempt(e.s, t.task_id, ['challenge']);
  const failed = failedSoftGates(t);
  if (!a) {
    // Filed before a crash, and the task hadn't moved yet.
    if (pendingDisagreements(e, t).length) {
      e.taskTo(t, 'TASK_DISAGREEMENT', 'challenge_filed', { next_step: 'adjudicate' });
      return true;
    }
    if (e.draining) return false;
    const elements = failed.flatMap((g) => (g.uncovered as string[]).map((el) => `${g.id}|${el}`));
    const open = elements.filter((k) => !t.adjudicated.includes(k));
    if (open.length === 0) {
      e.decide('DP-DISAGREEMENT', t, 'repair', t.task_id, 'CHALLENGE_PENDING', 'REPAIR_PENDING');
      e.taskTo(t, 'REPAIR_PENDING', 'no_challenge', { next_step: 'repair' });
      return true;
    }
    await e.refreshHealth(Object.keys(e.p.policy.workers.rungs));
    if (holdFor(e, t, 'challenge')?.waiting) return false;
    if (e.capBlocks()) return false;
    const rung = filerRung(e, t);
    if (!rung) {
      e.taskTo(t, 'TASK_WAITING_WORKER', 'no_compliant_rung', { next_step: 'challenge' });
      return true;
    }
    const snap = lastSnapshot(t);
    const commit = snap?.commit ?? (t.base_commit as string);
    const cwd = e.p.paths.checkout(e.o.runId, `chal-${t.task_id}-${e.nextAttemptId()}`);
    await e.p.git.removeWorktree(cwd);
    await e.p.git.addWorktree(cwd, null, commit);
    e.append('challenge.requested', t.task_id, { gates: failed.map((g) => g.id) });
    const brief = assemble(e.p.prompts.challenge ?? '', [
      [
        'failed_gates',
        failed.map((g) => ({
          gate_id: g.id,
          command: g.command,
          signature: g.signature,
          elements: g.uncovered,
          output: g.detail,
        })),
      ],
      ['spec', specExcerpt(e.spec)],
      ['diff', await e.p.git.diffText(t.base_commit as string, commit)],
    ]);
    const na = e.beginAttempt({
      task: t,
      step: 'challenge',
      rung,
      mode: 'read_only',
      cwd,
      brief,
      n: t.attempts,
      intent: 'review.intent',
      context: { tree_before: await e.p.git.worktreeTree(cwd) },
    });
    await e.spawnAttempt(na, { acs: t.spec.acceptance_criteria, files: failed.map((g) => g.id) });
    return true;
  }
  const out = await awaitReadStep(e, t, a);
  if (out.kind === 'wait') return false;
  if (out.kind === 'failed') return true;
  const parsed = parseBlock(out.raw.final_message, challengeSchema);
  if (!parsed.ok) {
    failReadStep(e, t, a, 'MALFORMED');
    return true;
  }
  const fresh = e.s.tasks[t.task_id];
  const contested = parsed.value.challenges.filter(
    (c) =>
      failed.some((g) => g.id === c.gate_id && (g.uncovered as string[]).includes(c.signature)) &&
      !fresh.adjudicated.includes(`${c.gate_id}|${c.signature}`),
  );
  if (contested.length === 0) {
    e.append('dispatch.classified', t.task_id, { attempt_id: a.attempt_id, class: 'OK' });
    e.decide(
      'DP-DISAGREEMENT',
      fresh,
      'repair',
      fresh.task_id,
      'CHALLENGE_PENDING',
      'REPAIR_PENDING',
    );
    e.taskTo(fresh, 'REPAIR_PENDING', 'no_challenge', { next_step: 'repair' });
    return true;
  }
  for (const c of contested) {
    openDisagreement(e, fresh, {
      kind: 'GATE_FAIL_AGENT_CHALLENGE',
      gate_id: c.gate_id,
      review_id: null,
      code_result: 'FAIL',
      agent_position: c.agent_position,
      filed_by: a.rung,
      reason: c.reason,
      requested_action: 'WAIVE',
      keys: [`${c.gate_id}|${c.signature}`],
      elements: [c.signature],
    });
  }
  e.append('dispatch.classified', t.task_id, { attempt_id: a.attempt_id, class: 'OK' });
  e.decide(
    'DP-DISAGREEMENT',
    fresh,
    'adjudicate',
    fresh.task_id,
    'CHALLENGE_PENDING',
    'TASK_DISAGREEMENT',
  );
  e.taskTo(fresh, 'TASK_DISAGREEMENT', 'challenge_filed', { next_step: 'adjudicate' });
  return true;
}

// --- Review ----------------------------------------------------------------------------------------

function changedFilesFor(t: TaskRec): string[] {
  const run = [...t.gate_runs].reverse().find((g: any) => g.changed);
  return ((run as any)?.changed ?? []).map((f: any) => f.path);
}

function filledSlots(t: TaskRec, tree: string) {
  return t.reviews.filter((r) => r.tree === tree && r.effective === 'PASS');
}

async function stepReviewing(e: Engine, t: TaskRec): Promise<boolean> {
  const snap = lastSnapshot(t);
  if (!snap) throw new InvariantViolation(`${t.task_id} reached REVIEWING with no snapshot`);
  const a = currentAttempt(e.s, t.task_id, ['review']);
  const authors = authorsOfTask(e.s, t.task_id);
  if (a) {
    const out = await awaitReadStep(e, t, a);
    if (out.kind === 'wait') return false;
    if (out.kind === 'failed') return true;
    const fresh = e.s.tasks[t.task_id];
    const reviewed = await collectReview(e, {
      t: fresh,
      a,
      raw: out.raw,
      kind: 'task',
      id: t.task_id,
      commit: snap.commit,
      tree: snap.tree,
      scopeAcs: t.spec.acceptance_criteria,
      changedFiles: changedFilesFor(fresh),
      authors,
      specSha: reviewSpecSha(e),
    });
    if (!reviewed) return true;
    const after = e.s.tasks[t.task_id];
    if (routeReview(e, after, snap.tree, reviewed.review.review_id)) return true;
    const refs = { fingerprints: reviewed.findings.map((f: any) => f.fingerprint) };
    const passedAll = filledSlots(after, snap.tree).length >= e.quorum();
    e.decide(
      'DP-REVIEW',
      after,
      passedAll ? 'accept_task' : 'proceed_to_review',
      after.task_id,
      'REVIEWING',
      passedAll ? 'TASK_PASSED' : 'REVIEWING',
      refs,
      snap.tree,
    );
    return true;
  }
  // A review that was recorded, but the crash fell before it was routed. Same policy, FAIL or PASS.
  const lastReview = t.reviews[t.reviews.length - 1];
  if (lastReview && lastReview.tree === snap.tree && !lastReview.routed) {
    if (routeReview(e, t, snap.tree, lastReview.review_id)) return true;
  }
  if (filledSlots(t, snap.tree).length >= e.quorum()) return completeTask(e, t);
  if (e.capBlocks()) return false;
  await e.refreshHealth(e.p.policy.workers.ladders.review);
  const hold = holdFor(e, t, 'review');
  if (hold?.waiting) return false;
  const usedRungs = filledSlots(t, snap.tree).map((r) => r.rung);
  const rung = hold
    ? hold.rung
    : e.pickReader(e.p.policy.workers.ladders.review, authors, [
        ...skipListFor(e, t, 'review'),
        ...usedRungs,
      ]);
  if (!rung) {
    e.taskTo(t, 'TASK_WAITING_WORKER', 'no_compliant_rung', { next_step: 'review' });
    return true;
  }
  const cwd = e.p.paths.checkout(e.o.runId, `rev-${t.task_id}-${e.nextAttemptId()}`);
  await e.p.git.removeWorktree(cwd);
  await e.p.git.addWorktree(cwd, null, snap.commit);
  const files = changedFilesFor(t);
  const brief = assemble(e.p.prompts.review ?? '', [
    ['spec', specExcerpt(e.spec)],
    ['task', t.spec],
    ['acceptance_criteria', t.spec.acceptance_criteria],
    ['diff', await e.p.git.diffText(t.base_commit as string, snap.commit)],
    ['gate_evidence', t.gate_runs[t.gate_runs.length - 1]?.results ?? []],
    ['claims_as_data', snap.claims],
    ['owner_covered_criteria', e.coveredAcs()],
  ]);
  const na = e.beginAttempt({
    task: t,
    step: 'review',
    rung,
    mode: 'read_only',
    cwd,
    brief,
    n: t.reviews.length + 1,
    intent: 'review.intent',
    slot: filledSlots(t, snap.tree).length,
    context: { tree_before: await e.p.git.worktreeTree(cwd) },
  });
  await e.spawnAttempt(na, { acs: t.spec.acceptance_criteria, files });
  return true;
}

// One policy for a recorded review, from a live collection or a replay. Returns true if it moved.
function routeReview(e: Engine, t: TaskRec, tree: string, reviewId: string): boolean {
  const review = t.reviews.find((r) => r.review_id === reviewId);
  if (!review) throw new InvariantViolation(`no review ${reviewId} on ${t.task_id}`);
  const refs = { fingerprints: review.fingerprints };
  const sameTree = t.reviews.filter((r) => r.tree === tree);
  const verdicts = new Set(sameTree.slice(-e.quorum()).map((r) => r.effective));
  if (e.quorum() > 1 && sameTree.length >= 2 && verdicts.size > 1) {
    openDisagreement(e, t, {
      kind: 'REVIEWER_REVIEWER',
      gate_id: null,
      review_id: reviewId,
      code_result: 'PASS',
      agent_position: 'REVIEWERS_SPLIT',
      filed_by: review.rung,
      reason: 'required reviewers disagree',
      requested_action: 'OVERRIDE_FINDING',
      keys: [`split:${tree}`],
    });
    e.decide('DP-REVIEW', t, 'adjudicate', t.task_id, 'REVIEWING', 'TASK_DISAGREEMENT', refs, tree);
    e.taskTo(t, 'TASK_DISAGREEMENT', 'reviewers_split', { next_step: 'adjudicate' });
    return true;
  }
  if (review.effective === 'FAIL') {
    openDisagreement(e, t, {
      kind: 'MECHANICAL_PASS_SEMANTIC_FAIL',
      gate_id: null,
      review_id: reviewId,
      code_result: 'PASS',
      agent_position: 'REVIEW_FAILED',
      filed_by: review.rung,
      reason: 'review FAIL after gates passed',
      requested_action: 'REPAIR',
      status: 'ROUTED_TO_REPAIR',
    });
    e.decide('DP-REVIEW', t, 'repair', t.task_id, 'REVIEWING', 'REPAIR_PENDING', refs, tree);
    e.taskTo(t, 'REPAIR_PENDING', 'review_failed', { next_step: 'repair' });
    return true;
  }
  return false;
}

async function completeTask(e: Engine, t: TaskRec): Promise<boolean> {
  const snap = lastSnapshot(t);
  if (!snap) throw new InvariantViolation(`${t.task_id} has no snapshot to commit`);
  const slots = filledSlots(t, snap.tree).map((r, slot) => ({
    slot,
    valid: true,
    independent: true,
    verdict: r.effective,
  }));
  const reviewed = checkReview(slots, e.quorum());
  if (!reviewed.ok) throw new InvariantViolation(`H-REVIEW: ${reviewed.detail}`);
  const run = [...t.gate_runs].reverse().find((g) => g.tree === snap.tree);
  const evidence = checkEvidence(
    (run?.results ?? [])
      .filter((r: any) => r.log_path)
      .map((r: any) => ({
        gate: r.id,
        log_sha: r.log_sha,
        tree_hash: r.tree_hash,
        log_path: r.log_path,
      })),
    snap.tree,
    (r) => {
      const text = e.p.store.read(r.log_path as string);
      return text !== null && sha256(text) === r.log_sha;
    },
  );
  if (!evidence.ok) throw new InvariantViolation(`H-EVIDENCE: ${evidence.detail}`);
  if (!run) throw new InvariantViolation(`H-EVIDENCE: no gate run for tree ${snap.tree}`);
  if (t.is_integration) return completeIntegrationTask(e, t);
  if (t.commit && (await e.p.git.treeOf(t.commit)) === snap.tree) {
    e.taskTo(t, 'TASK_PASSED', 'review_passed');
    return true;
  }
  const previous = t.commit;
  e.append('commit.intent', t.task_id, { tree: snap.tree });
  const commit = await e.p.git.commitTree(
    snap.tree,
    [t.base_commit as string],
    `${t.task_id}: ${t.spec.goal}\n\nTask: ${t.task_id}\nSpec: ${e.spec.spec_id}\nRun: ${e.o.runId}\n`,
  );
  const identity = checkTreeId(snap.tree, await e.p.git.treeOf(commit));
  e.append('tree.identity_checked', t.task_id, {
    ok: identity.ok,
    tree: snap.tree,
    phase: 'commit',
  });
  if (!identity.ok) throw new InvariantViolation(`H-TREE-ID at commit: ${identity.detail}`);
  await e.p.git.updateRef(`refs/heads/ecp/${e.o.runId}/${t.task_id}`, commit);
  e.append('commit.done', t.task_id, { commit, tree: snap.tree });
  e.taskTo(t, 'TASK_PASSED', 'review_passed', { commit });
  if (previous && previous !== commit) resetDependents(e, t.task_id);
  return true;
}

function resetDependents(e: Engine, taskId: string) {
  for (const x of Object.values(e.s.tasks)) {
    if (
      x.spec.depends_on.includes(taskId) &&
      x.state !== 'PENDING' &&
      x.state !== 'TASK_CANCELLED'
    ) {
      e.taskTo(x, 'PENDING', 'dependency_reset', { reset: true });
      resetDependents(e, x.task_id);
    }
  }
}

// --- Repair ----------------------------------------------------------------------------------------

async function stepRepairPending(e: Engine, t: TaskRec): Promise<boolean> {
  if (e.draining) return false;
  // Requested before a crash: charged once already, so go straight on. A required rung switch holds:
  // the stalled rung is on the skip list, so with no alternate the task waits.
  if (t.repair_requested) {
    const switching = t.stall_at === t.attempts && t.stalls > 0;
    if (!switching) {
      e.taskTo(t, 'DISPATCHING', 'repair_dispatch', { next_step: 'repair' });
      return true;
    }
    const ladder = ladderOf(e, t);
    await e.refreshHealth(ladder);
    const rung = e.pickWriter(ladder, skipListFor(e, t, 'repair'), null);
    if (rung) e.taskTo(t, 'DISPATCHING', 'repair_next_rung', { next_step: 'repair', rung });
    else e.taskTo(t, 'TASK_WAITING_WORKER', 'no_alternate', { next_step: 'repair' });
    return true;
  }
  const limit = t.repairs >= e.profile().repair_max;
  const signal = t.forced_stall ?? stallSignal(t.stall_history);
  const refs = { fingerprints: (t.open_findings as any[]).map((f) => f.fingerprint) };
  if (signal || limit) {
    const reason = signal ?? 'limit';
    // A stall already counted for this attempt, before a crash, isn't a second stall.
    const counted = t.stall_at === t.attempts;
    if (t.stalls >= (counted ? 2 : 1)) {
      if (!counted) e.append('stall.detected', t.task_id, { reason, second: true });
      const fresh = e.s.tasks[t.task_id];
      e.decide(
        'DP-REPAIR',
        fresh,
        'escalate',
        fresh.task_id,
        'REPAIR_PENDING',
        'TASK_ESCALATED',
        refs,
      );
      e.decide(
        'DP-ESCALATE',
        fresh,
        'escalate',
        'REPAIR_EXHAUSTED',
        'REPAIR_PENDING',
        'TASK_ESCALATED',
        refs,
      );
      e.taskTo(fresh, 'TASK_ESCALATED', 'repair_exhausted', {
        escalation_reason: 'REPAIR_EXHAUSTED',
      });
      return true;
    }
    // The stalled rung goes on the skip list with the stall itself, in one durable event.
    if (!counted)
      e.append('stall.detected', t.task_id, { reason, second: false, stalled_rung: t.rung });
    const fresh = e.s.tasks[t.task_id];
    const ladder = ladderOf(e, fresh);
    await e.refreshHealth(ladder);
    const current = fresh.rung;
    const next = e.pickWriter(
      ladder.filter((r) => r !== current),
      skipListFor(e, fresh, 'repair'),
      null,
    );
    if (!next) {
      e.decide('DP-REPAIR', fresh, 'wait', null, 'REPAIR_PENDING', 'TASK_WAITING_WORKER', refs);
      e.taskTo(fresh, 'TASK_WAITING_WORKER', 'no_alternate', { next_step: 'repair' });
      return true;
    }
    e.decide('DP-REPAIR', fresh, 'repair_next_rung', next, 'REPAIR_PENDING', 'DISPATCHING', refs);
    e.append('repair.requested', t.task_id, { switch_rung: true, reason, to: next });
    e.taskTo(fresh, 'DISPATCHING', 'repair_next_rung', { next_step: 'repair', rung: next });
    return true;
  }
  e.decide('DP-REPAIR', t, 'repair', t.task_id, 'REPAIR_PENDING', 'DISPATCHING', refs);
  e.append('repair.requested', t.task_id, { switch_rung: false });
  const fresh = e.s.tasks[t.task_id];
  e.taskTo(fresh, 'DISPATCHING', 'repair_dispatch', { next_step: 'repair' });
  return true;
}

// --- Disagreement ----------------------------------------------------------------------------------

function pendingDisagreements(e: Engine, t: TaskRec) {
  return Object.values(e.s.disagreements).filter(
    (d: any) => d.subject.task_id === t.task_id && d.adjudication.status === 'PENDING',
  ) as any[];
}

function escalateUnresolved(e: Engine, t: TaskRec, d: any, why: string) {
  e.append('disagreement.adjudicated', t.task_id, {
    id: d.id,
    adjudication: {
      status: 'ESCALATED',
      adjudicator: 'policy',
      reason: why,
      evidence: [],
      decided_at: new Date(e.now()).toISOString(),
    },
    counted: false,
  });
  const fresh = e.s.tasks[t.task_id];
  e.decide(
    'DP-DISAGREEMENT',
    fresh,
    'escalate',
    'UNRESOLVED_DISAGREEMENT',
    'TASK_DISAGREEMENT',
    'TASK_ESCALATED',
  );
  e.decide(
    'DP-ESCALATE',
    fresh,
    'escalate',
    'UNRESOLVED_DISAGREEMENT',
    'TASK_DISAGREEMENT',
    'TASK_ESCALATED',
  );
  e.taskTo(fresh, 'TASK_ESCALATED', 'unresolved', { escalation_reason: 'UNRESOLVED_DISAGREEMENT' });
  return true;
}

function routeAfterRulings(e: Engine, t: TaskRec, anyRejected: boolean, anyGate: boolean): boolean {
  const fresh = e.s.tasks[t.task_id];
  const snap = lastSnapshot(fresh);
  const hasDiff = snap !== null && snap.family !== null;
  if (anyRejected) {
    e.decide(
      'DP-DISAGREEMENT',
      fresh,
      'repair',
      fresh.task_id,
      'TASK_DISAGREEMENT',
      'REPAIR_PENDING',
    );
    e.taskTo(fresh, 'REPAIR_PENDING', 'rejected', { next_step: 'repair' });
  } else if (fresh.is_integration && !hasDiff) {
    e.decide(
      'DP-DISAGREEMENT',
      fresh,
      anyGate ? 'waive' : 'override',
      fresh.task_id,
      'TASK_DISAGREEMENT',
      'TASK_PASSED',
    );
    e.taskTo(fresh, 'TASK_PASSED', 'ruled_no_snapshot');
  } else if (anyGate) {
    e.decide('DP-DISAGREEMENT', fresh, 'waive', fresh.task_id, 'TASK_DISAGREEMENT', 'GATING');
    e.taskTo(fresh, 'GATING', 'gate_waived', { next_step: 'gate' });
  } else {
    e.decide('DP-DISAGREEMENT', fresh, 'override', fresh.task_id, 'TASK_DISAGREEMENT', 'REVIEWING');
    e.taskTo(fresh, 'REVIEWING', 'finding_overridden', { next_step: 'review' });
  }
  return true;
}

async function stepDisagreement(e: Engine, t: TaskRec): Promise<boolean> {
  const a = currentAttempt(e.s, t.task_id, ['adjudicate']);
  const pending = pendingDisagreements(e, t);
  if (!a) {
    if (pending.length === 0) {
      const batch = Object.values<any>(e.s.disagreements).filter(
        (d) =>
          d.subject.task_id === t.task_id &&
          !d.routed &&
          d.adjudication.status !== 'ROUTED_TO_REPAIR',
      );
      // A split or escalated ruling goes to the owner, even if a crash fell before the task moved.
      if (
        batch.some(
          (d) => d.adjudication.status === 'SPLIT' || d.adjudication.status === 'ESCALATED',
        )
      ) {
        e.decide(
          'DP-ESCALATE',
          t,
          'escalate',
          'UNRESOLVED_DISAGREEMENT',
          'TASK_DISAGREEMENT',
          'TASK_ESCALATED',
        );
        e.taskTo(t, 'TASK_ESCALATED', 'unresolved', {
          escalation_reason: 'UNRESOLVED_DISAGREEMENT',
        });
        return true;
      }
      const rejected = batch.some((d) => d.adjudication.status === 'REJECTED');
      return routeAfterRulings(
        e,
        t,
        rejected,
        batch.some((d) => d.subject.gate_id),
      );
    }
    const d = pending[0];
    if (d.kind === 'REVIEWER_REVIEWER' && e.s.risk === 'critical')
      return escalateUnresolved(e, t, d, 'critical: no agent ruling');
    if (e.s.risk === 'critical') return escalateUnresolved(e, t, d, 'critical: no agent waiver');
    if (t.adjudications >= 3) return escalateUnresolved(e, t, d, 'adjudication limit reached');
    if ((d.keys as string[]).every((k) => t.adjudicated.includes(k))) {
      e.append('disagreement.adjudicated', t.task_id, {
        id: d.id,
        adjudication: {
          status: 'REJECTED',
          adjudicator: 'policy',
          reason: 'already adjudicated',
          evidence: [],
          decided_at: new Date(e.now()).toISOString(),
        },
        counted: false,
      });
      return true;
    }
    if (e.draining) return false;
    const authors = t.is_integration
      ? [...new Set([...e.authorsIntegrated(), ...authorsOfTask(e.s, t.task_id)])]
      : authorsOfTask(e.s, t.task_id);
    const filerFamily = e.rung(d.filed_by) ? e.family(d.filed_by) : null;
    const reviewerFamilies = d.subject.review_id
      ? t.reviews.filter((r) => r.review_id === d.subject.review_id).map((r) => r.family)
      : [];
    const excluded = [
      ...new Set([...authors, ...(filerFamily ? [filerFamily] : []), ...reviewerFamilies]),
    ];
    const ladder = e.p.policy.workers.ladders.adjudication;
    if (!e.anyFamilyCouldQualify(ladder, excluded))
      return escalateUnresolved(e, t, d, 'no family could qualify as adjudicator');
    await e.refreshHealth(ladder);
    const hold = holdFor(e, t, 'adjudicate');
    if (hold?.waiting) return false;
    if (e.capBlocks()) return false;
    const rung = hold ? hold.rung : e.pickReader(ladder, excluded, skipListFor(e, t, 'adjudicate'));
    if (!rung) {
      e.taskTo(t, 'TASK_WAITING_WORKER', 'no_compliant_rung', { next_step: 'adjudicate' });
      return true;
    }
    const snap = lastSnapshot(t);
    const commit = snap?.commit ?? (t.base_commit as string);
    const cwd = e.p.paths.checkout(e.o.runId, `adj-${t.task_id}-${e.nextAttemptId()}`);
    await e.p.git.removeWorktree(cwd);
    await e.p.git.addWorktree(cwd, null, commit);
    const { filed_by: _hidden, ...withoutFiler } = d;
    const brief = assemble(e.p.prompts.adjudicate ?? '', [
      ['disagreement', withoutFiler],
      ['spec', specExcerpt(e.spec)],
      ['diff', await e.p.git.diffText(t.base_commit as string, commit)],
    ]);
    const na = e.beginAttempt({
      task: t,
      step: 'adjudicate',
      rung,
      mode: 'read_only',
      cwd,
      brief,
      n: t.adjudications + 1,
      intent: 'review.intent',
      context: { tree_before: await e.p.git.worktreeTree(cwd), disagreement: d.id },
    });
    await e.spawnAttempt(na, { acs: t.spec.acceptance_criteria, files: [] });
    return true;
  }
  const out = await awaitReadStep(e, t, a);
  if (out.kind === 'wait') return false;
  if (out.kind === 'failed') return true;
  const parsed = parseBlock(out.raw.final_message, rulingSchema);
  if (!parsed.ok) {
    failReadStep(e, t, a, 'MALFORMED');
    return true;
  }
  const fresh = e.s.tasks[t.task_id];
  const d = e.s.disagreements[a.context?.disagreement as string];
  const ruling = parsed.value.ruling;
  const adjudication = (status: string) => ({
    status,
    adjudicator: a.rung,
    reason: parsed.value.reason,
    evidence: parsed.value.evidence.map((x) => x.path),
    decided_at: new Date(e.now()).toISOString(),
  });
  const rule = (status: string) => {
    if (e.s.disagreements[d.id].adjudication.status === 'PENDING') {
      e.append('disagreement.adjudicated', t.task_id, {
        id: d.id,
        adjudication: adjudication(status),
        counted: true,
        keys: d.keys,
      });
    }
    e.append('dispatch.classified', t.task_id, { attempt_id: a.attempt_id, class: 'OK' });
  };
  if (ruling === 'SPLIT') {
    rule('SPLIT');
    e.decide(
      'DP-DISAGREEMENT',
      fresh,
      'escalate',
      'UNRESOLVED_DISAGREEMENT',
      'TASK_DISAGREEMENT',
      'TASK_ESCALATED',
    );
    e.decide(
      'DP-ESCALATE',
      fresh,
      'escalate',
      'UNRESOLVED_DISAGREEMENT',
      'TASK_DISAGREEMENT',
      'TASK_ESCALATED',
    );
    e.taskTo(e.s.tasks[t.task_id], 'TASK_ESCALATED', 'unresolved', {
      escalation_reason: 'UNRESOLVED_DISAGREEMENT',
    });
    return true;
  }
  if (ruling === 'REJECT') {
    rule('REJECTED');
  } else if (ruling === 'WAIVE' && d.subject.gate_id && /^S-/.test(d.subject.gate_id)) {
    const snap = lastSnapshot(fresh);
    const tree = snap?.tree ?? '0'.repeat(40);
    // Waivers first: the ruling only counts once its consequences are on the ledger.
    for (const el of d.elements as string[]) {
      if (e.hasWaiver(t.task_id, { gate_id: d.subject.gate_id, signature_element: el })) continue;
      e.append('waiver.recorded', t.task_id, {
        waiver: gateWaiver(
          `W-${e.s.waivers.length + 1}`,
          d.subject.gate_id,
          el,
          d.id,
          t.task_id,
          tree,
        ),
      });
    }
    rule('WAIVED_WITH_EVIDENCE');
  } else if ((ruling === 'OVERRIDE' || ruling === 'WAIVE') && !d.subject.gate_id) {
    const snap = lastSnapshot(fresh);
    const reviewId =
      d.subject.review_id ?? fresh.reviews[fresh.reviews.length - 1]?.review_id ?? null;
    const disputed = (d.keys as string[]).filter((k) => !k.startsWith('split:'));
    e.addFindingWaivers(
      e.s.tasks[t.task_id],
      reviewId,
      d.id,
      snap?.tree ?? '0'.repeat(40),
      disputed.length ? disputed : null,
    );
    rule('WAIVED_WITH_EVIDENCE');
  } else {
    // A ruling that doesn't fit its subject, such as OVERRIDE on a gate, doesn't count as a waiver.
    rule('REJECTED');
  }
  return true;
}

// --- Waiting ---------------------------------------------------------------------------------------

async function stepWaiting(e: Engine, t: TaskRec): Promise<boolean> {
  if (e.draining) return false;
  const all = Object.keys(e.p.policy.workers.rungs);
  await e.refreshHealth(all);
  if (t.next_step === 'gate') {
    e.taskTo(t, 'GATING', 'resume_gate');
    return true;
  }
  if (t.next_step === 'review') {
    const rung = e.pickReader(
      e.p.policy.workers.ladders.review,
      authorsOfTask(e.s, t.task_id),
      skipListFor(e, t, 'review'),
    );
    if (!rung) return false;
    e.taskTo(t, 'REVIEWING', 'eligible_review');
    return true;
  }
  if (t.next_step === 'challenge') {
    if (!filerRung(e, t)) return false;
    e.taskTo(t, 'CHALLENGE_PENDING', 'eligible_challenge');
    return true;
  }
  if (t.next_step === 'adjudicate') {
    const rung = e.pickReader(
      e.p.policy.workers.ladders.adjudication,
      authorsOfTask(e.s, t.task_id),
      skipListFor(e, t, 'adjudicate'),
    );
    if (!rung) return false;
    e.taskTo(t, 'TASK_DISAGREEMENT', 'eligible_adjudicate');
    return true;
  }
  const step = t.next_step === 'repair' ? 'repair' : 'work';
  const rung = e.pickWriter(ladderOf(e, t), skipListFor(e, t, step), t.rung);
  if (!rung) return false;
  e.taskTo(t, 'DISPATCHING', 'eligible_work', { rung });
  return true;
}
