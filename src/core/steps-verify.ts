import { checkAc, checkEvidence, checkLedger, checkReview, checkTreeId } from '../gates/checks.ts';
import { runGates } from '../gates/gates.ts';
import { sha256 } from '../ledger/canonical.ts';
import { loadLedger } from '../ledger/ledger.ts';
import { ruleRisk } from '../policy/risk.ts';
import { reportHasOnlyUnverifiableFailures } from '../review/effective.ts';
import { assemble, specExcerpt } from './briefs.ts';
import type { Engine } from './engine.ts';
import { InvariantViolation } from './reducer.ts';
import { currentAttempt } from './selectors.ts';
import { openIntegrationTask, tipOf, unionPaths } from './steps-integrate.ts';
import {
  awaitReadStep,
  collectReview,
  holdFor,
  reviewSpecSha,
  skipListFor,
} from './steps-review.ts';
import { trimResults, openDisagreement } from './steps-task.ts';

const LENSES = ['lens:security', 'lens:data_compat', 'lens:spec_fidelity'];

function stagesFor(e: Engine): string[] {
  const p = e.profile();
  const stages = ['gates', 'ac_commands', 'acceptance'];
  if (p.adversarial === 'one') stages.push('adversarial');
  if (p.adversarial === 'three_lenses') stages.push('adversarial', ...LENSES);
  return stages;
}

function repairOrExhaust(
  e: Engine,
  entry: 'REPAIR_PENDING' | 'CHALLENGE_PENDING' | 'TASK_DISAGREEMENT',
  o: { findings?: unknown[]; gate_runs?: unknown[]; split?: { review_id: string; rung: string } },
  refs: { fingerprints?: string[]; signatures?: string[] } = {},
): boolean {
  const alreadyOpen = Object.values(e.s.tasks).some(
    (x) => x.is_integration && !['TASK_PASSED', 'TASK_CANCELLED'].includes(x.state),
  );
  if (!alreadyOpen && e.s.integrated_repairs >= e.profile().integrated_repair_max) {
    e.decide(
      'DP-VERIFY',
      null,
      'escalate',
      'REPAIR_EXHAUSTED',
      'VERIFYING',
      'ESCALATION_REQUIRED',
      refs,
    );
    e.escalate('REPAIR_EXHAUSTED', null, 'integrated repair limit reached', 'repair_exhausted');
    return true;
  }
  e.decide('DP-VERIFY', null, 'repair', null, 'VERIFYING', 'INTEGRATING', refs);
  // A crash may have fallen after the task opened and before the run moved.
  const open = Object.values(e.s.tasks).find(
    (x) => x.is_integration && !['TASK_PASSED', 'TASK_CANCELLED'].includes(x.state),
  );
  if (open) {
    e.runTo('INTEGRATING', 'repairable');
    return true;
  }
  const t = openIntegrationTask(e, entry, o);
  if (o.split) {
    openDisagreement(e, t, {
      kind: 'REVIEWER_REVIEWER',
      gate_id: null,
      review_id: o.split.review_id,
      code_result: 'PASS',
      agent_position: 'REVIEWERS_SPLIT',
      filed_by: o.split.rung,
      reason: 'required reviewers disagree on the integrated candidate',
      requested_action: 'OVERRIDE_FINDING',
      keys: [`split:${o.split.review_id}`],
    });
  }
  e.runTo('INTEGRATING', 'repairable');
  return true;
}

async function stageGates(e: Engine): Promise<boolean> {
  const { git, runner, store } = e.p;
  const tip = tipOf(e);
  const tree = await git.treeOf(tip);
  const checkout = e.p.paths.checkout(e.o.runId, `verify-${e.s.verify.generation}`);
  await git.removeWorktree(checkout);
  await git.addWorktree(checkout, null, tip);
  e.append('gate.intent', null, { integrated: true, tree });
  const waivers = e.s.waivers
    .filter((w: any) => w.kind === 'gate')
    .map((w: any) => ({
      gate_id: w.resolves.gate_id,
      signature_element: w.resolves.signature_element,
    }));
  const out = await runGates({
    git,
    runner,
    store,
    spec: e.spec,
    subject: 'integrated',
    attemptN: e.s.verify.generation,
    allowed: unionPaths(e),
    forbidden: [],
    base: e.spec.target.base_commit,
    commit: tip,
    tree,
    checkout,
    requiredTests: e.spec.required_tests,
    requiredTestIds: e.spec.required_tests.map((t) => t.id),
    runFull: true,
    fullRuns: e.profile().integrated_full_runs,
    baselineFullSignature: e.s.baseline_signature,
    secretPatterns: e.secret,
    waivers,
  });
  await git.removeWorktree(checkout);
  const results = trimResults(out.results);
  e.append('gate.finished', null, {
    integrated: true,
    tree,
    classification: out.classification,
    results,
    changed: out.changed,
  });
  const seeded = [{ tree, attempt_n: e.s.verify.generation, results, changed: out.changed }];
  const refs = {
    signatures: out.results.filter((r) => r.status === 'FAIL').map((r) => r.signature ?? r.id),
  };
  switch (out.classification) {
    case 'hard_nonrepairable':
      e.decide(
        'DP-VERIFY',
        null,
        'escalate',
        'HARD_GATE_BREACH',
        'VERIFYING',
        'ESCALATION_REQUIRED',
        refs,
        tree,
      );
      e.escalate(
        'HARD_GATE_BREACH',
        null,
        out.results
          .filter((r) => r.status === 'FAIL')
          .map((r) => `${r.id}: ${r.detail}`)
          .join('; '),
        'hard_gate_breach',
      );
      return true;
    case 'tree_changed':
      e.append('evidence.discarded_stale', null, { tree, changed: out.tree_changed });
      return repairOrExhaust(e, 'REPAIR_PENDING', { gate_runs: seeded }, refs);
    case 'hard_repairable':
      return repairOrExhaust(e, 'REPAIR_PENDING', { gate_runs: seeded }, refs);
    case 'soft_failed':
      return repairOrExhaust(e, 'CHALLENGE_PENDING', { gate_runs: seeded }, refs);
    default:
      break;
  }
  if (
    e.raiseRisk(
      ruleRisk(
        e.p.policy.riskRules,
        out.changed.map((f) => f.path),
      ),
      'integrated diff',
    )
  ) {
    // A stricter profile may add stages; restart so it sees them all.
  }
  e.append('tree.identity_checked', null, { stage: 'gates', tree, ok: true });
  return true;
}

async function stageAcCommands(e: Engine): Promise<boolean> {
  const { git, runner, store } = e.p;
  const tip = tipOf(e);
  const tree = await git.treeOf(tip);
  const checkout = e.p.paths.checkout(e.o.runId, `ac-${e.s.verify.generation}`);
  await git.removeWorktree(checkout);
  await git.addWorktree(checkout, null, tip);
  const failures: {
    id: string;
    status: string;
    soft: boolean;
    detail: string;
    signature: string;
    uncovered: string[];
  }[] = [];
  for (const c of e.spec.acceptance_criteria) {
    for (const v of c.verify) {
      if (v.kind !== 'command') continue;
      e.append('gate.intent', null, { ac: c.id, tree });
      const res = await runner.run(v.command, { cwd: checkout, timeout_s: v.timeout_s });
      const rel = `evidence/integrated/${c.id}-${e.s.verify.generation}.log`;
      store.write(rel, res.log);
      const status = res.code === 0 ? 'PASS' : 'FAIL';
      e.append('gate.finished', null, {
        ac_id: c.id,
        status,
        tree,
        exit: res.code,
        log_sha: sha256(res.log),
        log_path: rel,
        results: [],
      });
      if (res.code !== 0)
        failures.push({
          id: 'H-AC',
          status: 'FAIL',
          soft: false,
          detail: `${c.id} exit ${res.code}`,
          signature: sha256(`${c.id}:${res.log}`),
          uncovered: [],
        });
    }
  }
  // A command that changed the tree voids its evidence, as for any gate.
  const after = await git.worktreeTree(checkout);
  await git.removeWorktree(checkout);
  if (after !== tree) {
    e.append('evidence.discarded_stale', null, { tree, stage: 'ac_commands' });
    const signature = sha256(`H-TREE-ID:ac:${after}`);
    const identity = {
      id: 'H-TREE-ID',
      status: 'FAIL',
      soft: false,
      detail: 'an acceptance command changed the tree',
      signature,
      uncovered: [],
    };
    return repairOrExhaust(
      e,
      'REPAIR_PENDING',
      { gate_runs: [{ tree, attempt_n: e.s.verify.generation, results: [identity] }] },
      { signatures: [signature] },
    );
  }
  if (failures.length) {
    return repairOrExhaust(
      e,
      'REPAIR_PENDING',
      { gate_runs: [{ tree, attempt_n: e.s.verify.generation, results: failures }] },
      { signatures: failures.map((f) => f.signature) },
    );
  }
  e.append('tree.identity_checked', null, { stage: 'ac_commands', tree, ok: true });
  return true;
}

function promptFor(stage: string): string {
  if (stage === 'acceptance') return 'acceptance';
  if (stage === 'adversarial') return 'adversarial';
  return 'lens';
}

function slotsFor(e: Engine, stage: string): number {
  return stage === 'acceptance' ? e.quorum() : 1;
}

// Derived from the ledger, so a crash after the review was recorded routes it the same way.
function routeVerifyFail(
  e: Engine,
  reviewId: string,
  stage: string,
  rung: string,
  tree: string,
): boolean {
  const review = JSON.parse(e.p.store.read(`reviews/${reviewId}.json`) as string);
  const refs = { fingerprints: review.findings.map((f: any) => f.fingerprint) };
  if (reportHasOnlyUnverifiableFailures(review, e.coveredAcs())) {
    const ac = review.criteria.find(
      (c: any) => c.verdict === 'UNVERIFIABLE' && !e.coveredAcs().includes(c.ac),
    );
    e.decide(
      'DP-VERIFY',
      null,
      'escalate',
      'UNVERIFIABLE_CRITERION',
      'VERIFYING',
      'ESCALATION_REQUIRED',
      refs,
      tree,
    );
    e.escalate(
      'UNVERIFIABLE_CRITERION',
      null,
      `${ac?.ac} can't be verified by the system`,
      'unverifiable',
    );
    return true;
  }
  const others = e.s.verify_review.verdicts.filter(
    (v) => v.review_id !== reviewId && v.stage === stage,
  );
  if (stage === 'acceptance' && others.some((v) => v.verdict === 'PASS')) {
    return repairOrExhaust(e, 'TASK_DISAGREEMENT', { split: { review_id: reviewId, rung } }, refs);
  }
  return repairOrExhaust(e, 'REPAIR_PENDING', { findings: review.findings }, refs);
}

async function stageReview(e: Engine, stage: string): Promise<boolean> {
  const tip = tipOf(e);
  const tree = await e.p.git.treeOf(tip);
  const authors = e.authorsIntegrated();
  const a = currentAttempt(e.s, null, [promptFor(stage)]);
  const scopeAcs = e.spec.acceptance_criteria.map((c) => c.id);
  const changed = (await e.p.git.changedFiles(e.spec.target.base_commit, tip)).map((f) => f.path);
  if (a) {
    const out = await awaitReadStep(e, null, a);
    if (out.kind === 'wait') return false;
    if (out.kind === 'failed') return true;
    const reviewed = await collectReview(e, {
      t: null,
      a,
      raw: out.raw,
      kind: 'integrated',
      id: stage.replace(':', '-'),
      commit: tip,
      tree,
      scopeAcs,
      changedFiles: changed,
      authors,
      stage,
      specSha: reviewSpecSha(e),
    });
    if (!reviewed) return true;
    if (reviewed.effective === 'FAIL')
      return routeVerifyFail(e, reviewed.review.review_id, stage, a.rung, tree);

    return true;
  }
  // Recorded before a crash, and not yet acted on.
  const passed = e.s.verify_review.verdicts.filter(
    (v) => v.stage === stage && v.verdict === 'PASS',
  ).length;
  if (passed >= slotsFor(e, stage)) {
    e.append('tree.identity_checked', null, { stage, tree, ok: true });
    return true;
  }
  if (e.capBlocks()) return false;
  const ladder =
    stage === 'acceptance'
      ? e.p.policy.workers.ladders.review
      : e.p.policy.workers.ladders.adversarial;
  await e.refreshHealth(ladder);
  const stepName = promptFor(stage);
  const hold = holdFor(e, null, stepName);
  if (hold?.waiting) return false;
  const used =
    stage === 'acceptance'
      ? Object.values(e.s.attempts)
          .filter(
            (x) =>
              x.step === 'acceptance' &&
              x.class === 'OK' &&
              (x.context?.generation as number) === e.s.verify.generation,
          )
          .map((x) => x.rung)
      : [];
  const rung = hold
    ? hold.rung
    : e.pickReader(ladder, authors, [...skipListFor(e, null, stepName), ...used]);
  if (!rung) {
    e.runTo('PAUSED_NO_WORKER', 'no_worker', {
      resume_to: 'VERIFYING',
      reason: `no independent reviewer for ${stage}`,
    });
    return true;
  }
  const cwd = e.p.paths.checkout(e.o.runId, `${stage.replace(':', '-')}-${e.nextAttemptId()}`);
  await e.p.git.removeWorktree(cwd);
  await e.p.git.addWorktree(cwd, null, tip);
  const brief = assemble(e.p.prompts[stepName] ?? '', [
    ['stage', stage],
    ['spec', specExcerpt(e.spec)],
    ['diff', await e.p.git.diffText(e.spec.target.base_commit, tip)],
    ['mechanical_ac_matrix', e.s.verify.ac_evidence],
    ['owner_covered_criteria', e.coveredAcs()],
  ]);
  const na = e.beginAttempt({
    task: null,
    step: stepName,
    rung,
    mode: 'read_only',
    cwd,
    brief,
    n: e.s.verify.generation,
    intent: 'review.intent',
    slot: e.s.verify_review.verdicts.length,
    context: {
      tree_before: await e.p.git.worktreeTree(cwd),
      generation: e.s.verify.generation,
      stage,
    },
  });
  await e.spawnAttempt(na, { acs: scopeAcs, files: changed });
  return true;
}

async function finishVerify(e: Engine): Promise<boolean> {
  const tip = tipOf(e);
  const tree = await e.p.git.treeOf(tip);
  const identity = checkTreeId(e.s.verify.tree ?? tree, tree);
  const reviews = e.s.verify_review.verdicts.map((v, i) => ({
    slot: i,
    valid: true,
    independent: true,
    verdict: v.verdict,
  }));
  const reviewed = checkReview(reviews, 1);
  const evidence = checkEvidence(
    e.s.verify.gate_results
      .filter((r: any) => r.log_path)
      .map((r: any) => ({
        gate: r.id,
        log_sha: r.log_sha,
        tree_hash: r.tree_hash,
        log_path: r.log_path,
      })),
    tree,
    (r) => {
      const text = e.p.store.read(r.log_path as string);
      return text !== null && sha256(text) === r.log_sha;
    },
  );
  const chain = checkLedger(() => loadLedger(e.p.ledgerStore));
  if (!chain.ok) throw new InvariantViolation(`H-LEDGER: ${chain.detail}`);
  const accepted = e.s.verify.accepted;
  const ac = checkAc(
    e.spec.acceptance_criteria.map((c) => {
      const commands = c.verify.filter((v) => v.kind === 'command');
      const semantic = c.verify.filter((v) => v.kind === 'semantic');
      const commandsOk = commands.length === 0 || e.s.verify.ac_evidence[c.id] === 'PASS';
      const semanticOk = semantic.length === 0 || accepted.includes(c.id);
      return {
        id: c.id,
        human_reserved: c.human_reserved,
        evidenced: commandsOk && semanticOk && c.verify.length > 0,
      };
    }),
    e.s.human_verified,
  );
  if (!identity.ok || !reviewed.ok || !evidence.ok || !ac.ok) {
    const detail = [identity, reviewed, evidence, ac]
      .filter((x) => !x.ok)
      .map((x) => x.detail)
      .join('; ');
    return repairOrExhaust(e, 'REPAIR_PENDING', {
      gate_runs: [
        {
          tree,
          attempt_n: e.s.verify.generation,
          results: [
            { id: 'H-AC', status: 'FAIL', soft: false, detail, signature: detail, uncovered: [] },
          ],
        },
      ],
    });
  }
  if (e.s.mock_review_seen) {
    e.decide('DP-VERIFY', null, 'mark_ready', null, 'VERIFYING', 'MOCK_RUN_COMPLETE', {}, tree);
    e.runTo('MOCK_RUN_COMPLETE', 'verified_mock', { reason: 'mock review: orchestration only' });
    return true;
  }
  if (e.s.risk === 'critical') {
    e.decide(
      'DP-VERIFY',
      null,
      'escalate',
      'HUMAN_IRREVERSIBLE_GATE',
      'VERIFYING',
      'ESCALATION_REQUIRED',
      {},
      tree,
    );
    e.escalate(
      'HUMAN_IRREVERSIBLE_GATE',
      null,
      'critical work needs the owner',
      'verified_critical',
    );
    return true;
  }
  e.decide('DP-VERIFY', null, 'mark_ready', null, 'VERIFYING', 'READY_FOR_HUMAN_MERGE', {}, tree);
  e.runTo('READY_FOR_HUMAN_MERGE', 'verified', { reason: 'all checks passed' });
  return true;
}

export async function stepVerifying(e: Engine): Promise<boolean> {
  const pending = e.s.verify.pending_fail;
  if (pending && !currentAttempt(e.s, null, ['acceptance', 'adversarial', 'lens'])) {
    const v = e.s.verify_review.verdicts.find((x) => x.review_id === pending);
    return routeVerifyFail(
      e,
      pending,
      v?.stage ?? 'acceptance',
      'unknown',
      await e.p.git.treeOf(tipOf(e)),
    );
  }
  const stages = stagesFor(e);
  const next = stages.find((s) => !e.s.verify.passed_stages.includes(s));
  if (!next) return finishVerify(e);
  if (next === 'gates') return e.draining ? false : stageGates(e);
  if (next === 'ac_commands') return e.draining ? false : stageAcCommands(e);
  return stageReview(e, next);
}
