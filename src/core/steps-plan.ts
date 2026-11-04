import { planSchema } from '../contracts/index.ts';
import { CONTROL_DEFAULTS, checkNoPush, checkRepo } from '../gates/checks.ts';
import { matchesAny } from '../gates/glob.ts';
import { gateSignature } from '../gates/signature.ts';

import { parseBlock } from '../review/report-block.ts';
import { assemble, specExcerpt } from './briefs.ts';
import type { RawOutcome } from '../contracts/index.ts';
import type { Engine } from './engine.ts';
import type { AttemptRec } from './reducer.ts';
import { planErrors, topoOrder } from './plan-validate.ts';
import {
  awaitReadStep,
  collectReview,
  failReadStep,
  holdFor,
  reviewSpecSha,
  skipListFor,
} from './steps-review.ts';
import { currentAttempt } from './selectors.ts';

export async function stepPreflight(e: Engine): Promise<boolean> {
  const { git } = e.p;
  const { spec } = e;
  const fail = (reason: string) => {
    e.runTo('FAILED', 'preflight_failed', { reason });
    return true;
  };
  const baseExists = (await git.resolveRef(spec.target.base_commit)) !== null;
  const repo = checkRepo(
    baseExists ? await git.rootCommit() : '',
    spec.target.repo_identity,
    baseExists,
  );
  if (!repo.ok) return fail(`H-REPO: ${repo.detail}`);
  if (!(await git.isClean())) return fail('H-CLEAN: target is dirty');
  const push = checkNoPush(await git.remotes());
  if (!push.ok) return fail(`H-NOPUSH: ${push.detail}`);
  try {
    const { assertMixedFamilies } = await import('../policy/load.ts');
    assertMixedFamilies(e.p.policy);
  } catch (err) {
    return fail(`invalid policy: ${(err as Error).message}`);
  }
  const tracked = await git.listTracked(spec.target.base_commit);
  const unlisted = tracked.filter(
    (p) => matchesAny(CONTROL_DEFAULTS, p) && !spec.known_control_files.includes(p),
  );
  if (unlisted.length) return fail(`unlisted control files: ${unlisted.join(', ')}`);
  e.checkSpecLock();
  const configBaseline = e.s.config_baseline ?? (await git.configFingerprint());

  // Baseline: the full suite on the base commit.
  const checkout = e.p.paths.checkout(e.o.runId, 'baseline');
  await git.removeWorktree(checkout);
  await git.addWorktree(checkout, null, spec.target.base_commit);
  e.append('gate.intent', null, { baseline: true });
  const res = await e.p.runner.run(spec.full_test_command.command, {
    cwd: checkout,
    timeout_s: spec.full_test_command.timeout_s,
  });
  await git.removeWorktree(checkout);
  const signature = res.code === 0 ? null : gateSignature('S-REGRESSION', res.log);
  e.append('gate.finished', null, {
    baseline: true,
    signature,
    config_baseline: configBaseline,
    tree: await git.treeOf(spec.target.base_commit),
    results: [],
  });
  if (res.code !== 0 && !spec.expect_red_baseline) return fail('unexpected red baseline');

  const all = Object.keys(e.p.policy.workers.rungs);
  await e.refreshHealth(all);
  const ladders = e.p.policy.workers.ladders;
  for (const lane of ['planning', 'review'] as const) {
    if (!ladders[lane].some((r) => e.rungAvailable(r))) {
      e.runTo('PAUSED_NO_WORKER', 'no_worker', {
        resume_to: 'PREFLIGHT',
        reason: `lane ${lane} has no eligible worker`,
      });
      return true;
    }
  }
  e.runTo('PLANNING', 'checks_passed');
  return true;
}

function pauseNoWorker(e: Engine, reason: string): boolean {
  e.runTo('PAUSED_NO_WORKER', 'no_worker', { resume_to: 'PLANNING', reason });
  return true;
}

async function startPlan(e: Engine): Promise<boolean> {
  const { policy } = e.p;
  const ladder = policy.workers.ladders.planning;
  await e.refreshHealth(ladder);
  const hold = holdFor(e, null, 'plan');
  if (hold?.waiting) return false;
  const skip = skipListFor(e, null, 'plan');
  const changed =
    e.s.plan_rung_changes > 0
      ? ladder.filter(
          (r) =>
            e.s.attempts &&
            Object.values(e.s.attempts).some((a) => a.step === 'plan' && a.rung === r),
        )
      : [];
  const rung = hold ? hold.rung : e.pickReader(ladder, [], [...skip, ...changed]);
  if (!rung) return pauseNoWorker(e, 'no eligible planner');
  if (e.capBlocks()) return false;
  const cwd = e.p.paths.checkout(e.o.runId, `plan-${e.nextAttemptId()}`);
  await e.p.git.removeWorktree(cwd);
  await e.p.git.addWorktree(cwd, null, e.spec.target.base_commit);
  const files = await e.p.git.listTracked(e.spec.target.base_commit);
  const brief = assemble(e.p.prompts.plan ?? '', [
    ['spec', specExcerpt(e.spec)],
    ['repo_tree', files],
    ['lanes', ['research', 'implementation', 'hard-code', 'tests']],
    ['prior_findings', e.s.plan_review_findings],
  ]);
  const a = e.beginAttempt({
    task: null,
    step: 'plan',
    rung,
    mode: 'read_only',
    cwd,
    brief,
    n: Object.values(e.s.attempts).filter((x) => x.step === 'plan').length + 1,
    intent: 'plan.intent',
    context: { tree_before: await e.p.git.worktreeTree(cwd) },
  });
  await e.spawnAttempt(a, { acs: e.spec.acceptance_criteria.map((c) => c.id), files: [] });
  return true;
}

async function acceptPlan(e: Engine): Promise<boolean> {
  // Idempotent: a crash part-way through opens only the tasks not yet open.
  const plan = e.s.plan ?? e.s.plan_candidate;
  if (!plan) return false;
  if (!e.s.plan) {
    e.decide('DP-PLAN', null, 'integrate', null, 'PLANNING', 'EXECUTING');
    e.append('plan.accepted', null, { plan });
  }
  e.p.store.write('plan.json', JSON.stringify(plan, null, 2));
  for (const id of topoOrder(plan.tasks)) {
    const t = plan.tasks.find((x) => x.task_id === id);
    if (!t || e.s.tasks[id]) continue;
    e.append('task.state_changed', id, {
      from: null,
      to: 'PENDING',
      spec: {
        goal: t.goal,
        lane: t.lane,
        allowed_paths: t.allowed_paths,
        forbidden_paths: t.forbidden_paths,
        acceptance_criteria: t.acceptance_criteria,
        required_tests: t.required_tests,
        depends_on: t.depends_on,
      },
    });
  }
  e.runTo('EXECUTING', 'plan_valid');
  return true;
}

async function startPlanReview(e: Engine): Promise<boolean> {
  const ladder = e.p.policy.workers.ladders.review;
  await e.refreshHealth(ladder);
  const hold = holdFor(e, null, 'plan_review');
  if (hold?.waiting) return false;
  const excluded = e.s.planner_family ? [e.s.planner_family] : [];
  const rung = hold
    ? hold.rung
    : e.pickReader(ladder, excluded, skipListFor(e, null, 'plan_review'));
  if (!rung) return pauseNoWorker(e, 'no reviewer outside the planner family');
  if (e.capBlocks()) return false;
  const cwd = e.p.paths.checkout(e.o.runId, `planrev-${e.nextAttemptId()}`);
  await e.p.git.removeWorktree(cwd);
  await e.p.git.addWorktree(cwd, null, e.spec.target.base_commit);
  const brief = assemble(e.p.prompts.plan_review ?? '', [
    ['spec', specExcerpt(e.spec)],
    ['plan', e.s.plan_candidate],
  ]);
  const a = e.beginAttempt({
    task: null,
    step: 'plan_review',
    rung,
    mode: 'read_only',
    cwd,
    brief,
    n: 1,
    intent: 'review.intent',
    context: { tree_before: await e.p.git.worktreeTree(cwd) },
  });
  await e.spawnAttempt(a, { acs: e.spec.acceptance_criteria.map((c) => c.id), files: [] });
  return true;
}

export async function stepPlanning(e: Engine): Promise<boolean> {
  const a = currentAttempt(e.s, null, ['plan', 'plan_review']);
  if (a) {
    const out = await awaitReadStep(e, null, a);
    if (out.kind === 'wait') return false;
    if (out.kind === 'failed') return true;
    if (a.step === 'plan_review') {
      const tree = await e.p.git.treeOf(e.spec.target.base_commit);
      const reviewed = await collectReview(e, {
        t: null,
        a,
        raw: out.raw,
        kind: 'plan',
        id: 'plan',
        commit: e.spec.target.base_commit,
        tree,
        scopeAcs: e.spec.acceptance_criteria.map((c) => c.id),
        changedFiles: [],
        authors: e.s.planner_family ? [e.s.planner_family] : [],
        stage: 'plan_review',
        specSha: reviewSpecSha(e),
      });
      if (!reviewed) return true;
      return routePlanReview(e, reviewed.effective, reviewed.findings);
    }
    return collectPlan(e, a, out.raw);
  }
  if (e.s.plan) return acceptPlan(e);
  if (e.s.plan_pending_fail) {
    const stored = JSON.parse(e.p.store.read(`reviews/${e.s.plan_pending_fail}.json`) as string);
    return routePlanReview(e, 'FAIL', stored.findings);
  }
  if (e.s.plan_candidate) {
    if (e.profile().plan_review && !e.s.plan_reviewed) return startPlanReview(e);
    return acceptPlan(e);
  }
  return startPlan(e);
}

function routePlanReview(
  e: Engine,
  effective: string,
  findings: unknown[],
): boolean | Promise<boolean> {
  if (effective === 'PASS') return acceptPlan(e);
  if (e.s.plan_reviews_failed >= 1) {
    e.append('plan.rejected', null, { kind: 'review_failed', findings });
    e.escalate('PLAN_INVALID', null, 'plan review failed twice', 'plan_invalid');
    return true;
  }
  e.decide('DP-PLAN', null, 'replan', null, 'PLANNING', 'PLANNING');
  e.append('plan.rejected', null, { kind: 'review_failed', findings });
  e.runTo('PLANNING', 'replan', { reason: 'plan review failed' });
  return true;
}

function collectPlan(e: Engine, a: AttemptRec, raw: RawOutcome): boolean {
  const parsed = parseBlock(raw.final_message, planSchema);
  if (!parsed.ok) {
    failReadStep(e, null, a, 'MALFORMED');
    return true;
  }
  const plan = parsed.value;
  if (plan.spec_defects.length) {
    e.append('dispatch.classified', null, { attempt_id: a.attempt_id, class: 'OK' });
    e.escalate('SPEC_DEFECT', null, plan.spec_defects.map((d) => d.text).join('; '), 'spec_defect');
    return true;
  }
  const errors = planErrors(plan, e.spec, e.profile().max_tasks, e.s.depth === 'QUICK');
  if (errors.length) {
    e.append('dispatch.classified', null, { attempt_id: a.attempt_id, class: 'OK' });
    if (e.s.plan_rejected >= 2) {
      e.append('plan.rejected', null, { kind: 'invalid', errors });
      e.escalate('PLAN_INVALID', null, errors.join('; '), 'plan_invalid');
      return true;
    }
    e.decide('DP-PLAN', null, 'replan', null, 'PLANNING', 'PLANNING');
    e.append('plan.rejected', null, {
      kind: 'invalid',
      errors,
      rung_change: e.s.plan_rejected >= 1,
    });
    e.runTo('PLANNING', 'replan', { reason: 'plan invalid' });
    return true;
  }
  e.append('dispatch.classified', null, { attempt_id: a.attempt_id, class: 'OK', plan });
  e.raiseRisk(plan.proposed_risk, 'planner');
  return true;
}
