import type { FailureClass, RawOutcome, ReviewReport } from '../contracts/index.ts';
import { reviewReportSchema, SEMANTIC_CHECKS } from '../contracts/index.ts';
import { sha256 } from '../ledger/canonical.ts';
import { consistencyErrors } from '../review/consistency.ts';
import { effectiveVerdict, waiverVoidCause } from '../review/effective.ts';
import { type AnchorSource, computeFinding, identityErrors } from '../review/fingerprint.ts';
import { parseBlock } from '../review/report-block.ts';
import type { Engine } from './engine.ts';
import { sweepAttempt } from './recovery.ts';
import type { AttemptRec, TaskRec } from './reducer.ts';

export type StepOutcome = { kind: 'wait' } | { kind: 'failed' } | { kind: 'ok'; raw: RawOutcome };

export function skipListFor(e: Engine, t: TaskRec | null, step: string): string[] {
  const list = t ? t.skip_rungs : e.s.run_skip_rungs;
  return list.filter((k) => k.startsWith(`${step}:`)).map((k) => k.slice(step.length + 1));
}

export function holdFor(
  e: Engine,
  t: TaskRec | null,
  step: string,
): { rung: string; waiting: boolean } | null {
  const hold = t ? t.hold : e.s.run_hold;
  if (!hold || hold.step !== step) return null;
  if (hold.not_before > e.now()) {
    e.setWake(hold.not_before);
    return { rung: hold.rung, waiting: true };
  }
  return { rung: hold.rung, waiting: false };
}

export function retriesFor(e: Engine, t: TaskRec | null, key: string): number {
  return (t ? t.rung_retries[key] : e.s.run_step_retries[key]) ?? 0;
}

// Handles a failed read-only step: re-ask, retry, quarantine or move on (state machine §4.8).
export function failReadStep(
  e: Engine,
  t: TaskRec | null,
  a: AttemptRec,
  cls: FailureClass,
  statedReset: number | null = null,
) {
  const key = `${a.step}:${a.rung}:${cls}`;
  const plan = e.planFailure(cls, a, retriesFor(e, t, key), statedReset);
  if (!a.class)
    e.append('dispatch.classified', a.task_id, { attempt_id: a.attempt_id, class: cls });
  e.decide(
    'DP-FALLBACK',
    t,
    plan.retry_same ? 'retry_same_rung' : 'next_rung',
    a.rung,
    t?.state ?? e.s.state,
    t?.state ?? e.s.state,
  );
  e.applyFailurePlan(a, cls, plan, key, null);
}

// The identity result goes on the ledger before the checkout does, so a crash can't lose it.
// Returns null when the checkout is gone with nothing recorded: the output can't be trusted.
export async function endReadCheckout(e: Engine, a: AttemptRec): Promise<boolean | null> {
  const recorded = e.s.attempts[a.attempt_id].tree_ok;
  if (recorded !== null) {
    await e.p.git.removeWorktree(a.cwd);
    return recorded;
  }
  const before = a.context?.tree_before as string | undefined;
  let after: string;
  try {
    after = await e.p.git.worktreeTree(a.cwd);
  } catch {
    return null;
  }
  const ok = after === before;
  e.append('tree.identity_checked', a.task_id, {
    attempt_id: a.attempt_id,
    phase: 'read_only',
    ok,
    tree: before,
  });
  await e.p.git.removeWorktree(a.cwd);
  return ok;
}

// Waits for the step's result. On any failure, this records it and the caller just returns.
export async function awaitReadStep(
  e: Engine,
  t: TaskRec | null,
  a: AttemptRec,
): Promise<StepOutcome> {
  let raw = a.finished ? e.loadRaw(a) : e.outcomeOf(a.attempt_id);
  if (!raw) return { kind: 'wait' };
  e.checkSpecLock();
  if (!a.finished) e.recordFinish(a, raw);
  raw = raw as RawOutcome;
  await sweepAttempt(e, a);
  if (a.mode !== 'read_only') return { kind: 'ok', raw };
  const unchanged = await endReadCheckout(e, a);
  if (unchanged === null) {
    // No evidence that the checkout stayed read-only: discard the output, and run the step again.
    e.append('evidence.discarded_stale', a.task_id, {
      attempt_id: a.attempt_id,
      reason: 'review checkout missing',
    });
    e.append('attempt.result_fenced', a.task_id, {
      attempt_id: a.attempt_id,
      reason: 'review checkout missing',
    });
    return { kind: 'failed' };
  }
  if (!unchanged) {
    e.append('dispatch.classified', a.task_id, {
      attempt_id: a.attempt_id,
      class: 'UNKNOWN',
      tree_changed: true,
    });
    e.append('worker.quarantined', a.task_id, {
      rung: a.rung,
      until: null,
      reason: 'checkout tree changed',
      scope: 'run',
    });
    e.append('fallback.taken', a.task_id, {
      from: a.rung,
      to: 'none',
      class: 'UNKNOWN',
      step: a.step,
      key: `${a.step}:${a.rung}:TREE_CHANGED`,
      next_rung: false,
      not_before: null,
      skip: `${a.step}:${a.rung}`,
    });
    return { kind: 'failed' };
  }
  const cls: FailureClass = raw.spawn_failed ? 'UNKNOWN' : e.classifyRaw(a, raw);
  if (cls !== 'OK') {
    failReadStep(e, t, a, cls, null);
    return { kind: 'failed' };
  }
  return { kind: 'ok', raw };
}

export type ReviewInput = {
  t: TaskRec | null;
  a: AttemptRec;
  raw: RawOutcome;
  kind: 'task' | 'integrated' | 'plan';
  id: string;
  commit: string;
  tree: string;
  scopeAcs: string[];
  changedFiles: string[];
  authors: string[];
  stage?: string;
  specSha: string;
};

function anchorSource(e: Engine, commit: string, tree: string): AnchorSource {
  return {
    tree,
    readFile: (p) => e.p.git.readFile(commit, p),
    blobId: (p) => e.p.git.blobId(commit, p),
  };
}

// Applies every code check to one review. Returns null when the review was invalid, already recorded.
export async function collectReview(e: Engine, input: ReviewInput) {
  const { t, a, raw } = input;
  const prior = e.s.reviewed_attempts[a.attempt_id];
  if (prior) {
    // Recorded before a crash: classify, and rebuild from the stored review.
    const stored = JSON.parse(e.p.store.read(`reviews/${prior}.json`) as string);
    if (!e.s.attempts[a.attempt_id].class)
      e.append('dispatch.classified', a.task_id, { attempt_id: a.attempt_id, class: 'OK' });
    const eff = effectiveVerdict(
      stored,
      e.s.waivers.filter((w) => w.kind === 'finding') as never,
      e.coveredAcs(),
    );
    return {
      review: stored,
      report: stored as ReviewReport,
      effective: eff.verdict,
      findings: stored.findings,
    };
  }
  const parsed = parseBlock(raw.final_message, reviewReportSchema);
  const invalid = (why: string) => {
    e.append('review.invalid', a.task_id, {
      attempt_id: a.attempt_id,
      reason: why,
      key: `${a.step}:${a.rung}:MALFORMED`,
    });
    failReadStep(e, t, a, 'MALFORMED');
    return null;
  };
  if (!parsed.ok) return invalid(parsed.error);
  const report: ReviewReport = parsed.value;

  const reviewerFamily = a.family;
  if (input.authors.includes(reviewerFamily) || reviewerFamily === 'unknown') {
    return invalid(
      `reviewer family ${reviewerFamily} isn't independent of ${input.authors.join(', ')}`,
    );
  }
  let familySource: 'registry_assertion' | 'reported_model' = 'registry_assertion';
  if (raw.model_reported) {
    if (e.familyOfModel(raw.model_reported) !== reviewerFamily) {
      return invalid(`reported model ${raw.model_reported} isn't family ${reviewerFamily}`);
    }
    familySource = 'reported_model';
  }
  const src = anchorSource(e, input.commit, input.tree);
  const errors = [
    ...consistencyErrors(report, {
      scopeAcs: input.scopeAcs,
      coveredAcs: e.coveredAcs(),
      changedFiles: input.changedFiles,
      requireFileCoverage: input.kind !== 'plan',
    }),
    ...(input.kind === 'plan' ? [] : await identityErrors(report.findings, src)),
  ];
  if (errors.length) return invalid(errors.join('; '));

  const findings = await Promise.all(report.findings.map((f) => computeFinding(f, src)));
  const seq = Object.keys(e.s.attempts).length;
  const review_id = `R-${input.id}-${String(seq).padStart(3, '0')}`;
  const rung = e.rung(a.rung);
  const mock = raw.transport_provenance !== 'real';
  const review = {
    schema: 'review.v1' as const,
    review_id,
    subject: { kind: input.kind, id: input.id, commit_or_tree: input.commit },
    reviewer: {
      rung_id: a.rung,
      adapter: rung.adapter,
      model_requested: rung.model,
      model_reported: raw.model_reported,
      family: reviewerFamily,
      session_id: raw.session_id,
    },
    independence: {
      authors: input.authors,
      reviewer_family: reviewerFamily,
      independent: true,
      family_source: familySource,
    },
    subject_tree: input.tree,
    inputs: {
      spec_sha: input.specSha,
      task_sha: null,
      diff_sha: null,
      plan_sha: null,
      evidence_shas: [],
    },
    verdict: report.verdict,
    criteria: report.criteria,
    semantic_checks: report.semantic_checks,
    findings,
    claims_reviewed: report.claims_reviewed,
    looked_at: report.looked_at,
    mock,
  };
  const scoped = e.s.waivers.filter((w) => w.kind === 'finding');
  const eff = effectiveVerdict(review, scoped as never, e.coveredAcs());
  const blockingFps = findings
    .filter((f) => f.severity === 'blocker' || f.severity === 'major')
    .map((f) => f.fingerprint);
  const voids = blockingFps
    .filter((fp) => !scoped.some((w: any) => w.resolves.finding_fingerprint === fp))
    .map((fp) => ({ fingerprint: fp, cause: waiverVoidCause(fp, scoped as never) }))
    .filter((v) => v.cause !== null);
  e.p.store.write(`reviews/${review_id}.json`, JSON.stringify(review, null, 2));
  e.append('review.collected', a.task_id, {
    attempt_id: a.attempt_id,
    passed_acs: report.criteria.filter((c) => c.verdict === 'PASS').map((c) => c.ac),
    review_id,
    tree: input.tree,
    verdict: report.verdict,
    effective: eff.verdict,
    unresolved: eff.unresolved,
    rung: a.rung,
    family: reviewerFamily,
    slot: a.slot ?? 0,
    stage: input.stage,
    mock,
    fingerprints: blockingFps,
    stall_keys: findings
      .filter((f) => f.severity === 'blocker' || f.severity === 'major')
      .map((f) => f.stall_key),
    findings,
    waiver_void: voids,
    not_examined: report.looked_at.not_examined,
  });
  e.append('dispatch.classified', a.task_id, { attempt_id: a.attempt_id, class: 'OK' });
  return { review, report, effective: eff.verdict, findings };
}

export function reviewSpecSha(e: Engine): string {
  return e.o.specSha.length === 64 ? e.o.specSha : sha256(e.o.specSha);
}

export { SEMANTIC_CHECKS };
