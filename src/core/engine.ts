import type {
  DispatchRequest,
  EventType,
  FailureClass,
  LedgerEvent,
  RawOutcome,
  Spec,
  TaskStateName,
  RunStateName,
  EscalationReason,
  Profile,
  WorkerAdapter,
} from '../contracts/index.ts';
import { Ledger, LedgerCorrupt, loadLedger } from '../ledger/ledger.ts';
import { canonical, sha256 } from '../ledger/canonical.ts';
import { checkSpecLock } from '../gates/checks.ts';
import { effectiveDepth, maxRisk, specRuleRisk } from '../policy/risk.ts';
import { compileSecretPatterns } from '../gates/secret.ts';
import { optionsFor } from './escalations.ts';
import { fallbackPlan } from './fallback.ts';
import { type EngineOptions, type EnginePorts, SimulatedKill } from './ports.ts';
import {
  applyInPlace,
  type AttemptRec,
  InvariantViolation,
  initialRun,
  type RunR,
  replay,
  type TaskRec,
} from './reducer.ts';
import {
  authorsIntegrated,
  familyOfModel,
  familyOfRung,
  rungWouldStrandReview,
} from './selectors.ts';
import { PAUSED, RUN_STOPPING } from './tables.ts';
import { stepTasks } from './steps-task.ts';
import { stepPlanning, stepPreflight } from './steps-plan.ts';
import { stepIntegrating } from './steps-integrate.ts';
import { stepVerifying } from './steps-verify.ts';
import { stepPushing } from './steps-publish.ts';
import { reconcileOpenAttempts, sweepAttempt } from './recovery.ts';

export const EXIT: Partial<Record<RunStateName, number>> = {
  READY_FOR_HUMAN_MERGE: 0,
  MOCK_RUN_COMPLETE: 0,
  PR_OPENED: 0,
  FAILED: 2,
  PAUSED_NO_WORKER: 3,
  PAUSED_BUDGET: 3,
  PAUSED_OPERATOR: 3,
  ESCALATION_REQUIRED: 4,
  PUSH_BLOCKED: 5,
  CANCELLED: 6,
};
const ACTIVE: RunStateName[] = ['PLANNING', 'EXECUTING', 'INTEGRATING', 'VERIFYING'];
const ACTIVE_TASK: TaskStateName[] = [
  'DISPATCHING',
  'WORKING',
  'COLLECTING',
  'GATING',
  'CHALLENGE_PENDING',
  'REVIEWING',
  'REPAIR_PENDING',
  'TASK_DISAGREEMENT',
];

export type RunExit = { state: RunStateName; code: number };
type Inflight = {
  adapter: WorkerAdapter;
  handle: { attempt_id: string; pid: number | null; start_time: string | null } | null;
  done: RawOutcome | null;
  startedMs: number;
  reattached?: boolean;
};
export type Health = { ok: boolean; reason: string | null; at: number };

export class Engine {
  s: RunR = initialRun();
  readonly p: EnginePorts;
  readonly o: EngineOptions;
  readonly spec: Spec;
  readonly secret: { id: string; re: RegExp }[];
  ledger!: Ledger;
  inflight = new Map<string, Inflight>();
  private notified = false;
  private listeners: (() => void)[] = [];
  health = new Map<string, Health>();
  draining: 'budget' | null = null;
  wakeAt: number | null = null;
  private lastHeartbeat = 0;
  private counts = new Map<string, number>();

  decisionOnResume: Record<string, unknown> | null = null;

  constructor(o: EngineOptions, p: EnginePorts) {
    this.o = o;
    this.p = p;
    this.spec = o.spec;
    this.secret = compileSecretPatterns(p.policy.secretPatterns);
  }

  // --- Ledger -------------------------------------------------------------------------------

  append(type: EventType, taskId: string | null, data: Record<string, unknown>): LedgerEvent {
    const ev = this.ledger.append(type, taskId, data);
    applyInPlace(this.s, ev);
    const n = (this.counts.get(type) ?? 0) + 1;
    this.counts.set(type, n);
    this.p.failpoint(`after:${type}`);
    this.p.failpoint(`after:${type}#${n}`);
    return ev;
  }

  runTo(to: RunStateName, trigger: string, data: Record<string, unknown> = {}) {
    this.append('run.state_changed', null, { from: this.s.state, to, trigger, ...data });
    this.project();
    if (
      to === 'PAUSED_NO_WORKER' ||
      to === 'PAUSED_BUDGET' ||
      to === 'PAUSED_OPERATOR' ||
      to === 'ESCALATION_REQUIRED' ||
      RUN_STOPPING.includes(to)
    ) {
      const ok = this.safeNotify(to, String(data.reason ?? trigger));
      this.append(ok ? 'notification.sent' : 'notification.failed', null, { kind: to });
    }
  }

  private safeNotify(kind: string, summary: string): boolean {
    try {
      this.p.notify(kind, summary);
      return true;
    } catch {
      return false;
    }
  }

  taskTo(t: TaskRec, to: TaskStateName, trigger: string, data: Record<string, unknown> = {}) {
    this.append('task.state_changed', t.task_id, { from: t.state, to, trigger, ...data });
  }

  // --- Decision points. Nothing the observer does reaches a transition. ---------------------------

  decide(
    point: string,
    t: TaskRec | null,
    action: string,
    target: string | null,
    from: string,
    to: string,
    refs: { fingerprints?: string[]; signatures?: string[] } = {},
    subjectTree: string | null = null,
  ) {
    const n = this.s.last_decision + 1;
    const decision_id = `DP-${String(n).padStart(4, '0')}`;
    const record = {
      n,
      decision_id,
      point,
      action,
      target,
      transition: { from, to },
      refs: { fingerprints: refs.fingerprints ?? [], signatures: refs.signatures ?? [] },
      risk: this.s.risk,
      subject_tree: subjectTree,
    };
    this.append('decision.made', t?.task_id ?? null, record);
    this.observe(() => {
      this.p.observer?.onDecision({
        decision_id,
        point,
        task_id: t?.task_id ?? null,
        risk: this.s.risk,
        subject_tree: subjectTree,
        action,
        target,
        transition: { from, to },
        refs: record.refs,
        bundle: this.bundle(t),
      });
    }, decision_id);
  }

  // A failing observer costs coverage, recorded as such, and never reaches steering.
  private observe<T>(fn: () => T, decisionId: string | null = null): T | null {
    if (!this.p.observer) return null;
    try {
      return fn();
    } catch (err) {
      this.append('shadow.unavailable', null, {
        decision_id: decisionId,
        status: 'SHADOW_UNAVAILABLE',
        class: 'OBSERVER_ERROR',
        detail: String(err),
      });
      return null;
    }
  }

  // The frozen input. Excludes the coordinator's choice and all earlier shadow output.
  private bundle(t: TaskRec | null): Record<string, unknown> {
    const s = this.s;
    return JSON.parse(
      JSON.stringify({
        spec: {
          spec_id: this.spec.spec_id,
          goal: this.spec.goal,
          acceptance_criteria: this.spec.acceptance_criteria.map((c) => ({
            id: c.id,
            text: c.text,
          })),
        },
        plan: s.plan,
        run_state: s.state,
        risk: s.risk,
        depth: s.depth,
        task: t
          ? {
              task_id: t.task_id,
              state: t.state,
              next_step: t.next_step,
              spec: t.spec,
              attempts: t.attempts,
              repairs: t.repairs,
              stalls: t.stalls,
              rung: t.rung,
            }
          : null,
        gate_results: t?.gate_runs[t.gate_runs.length - 1] ?? null,
        findings: t?.open_findings ?? [],
        disagreements: Object.values(s.disagreements),
        waivers: s.waivers,
        attempt_history: Object.values(s.attempts)
          .filter((a) => a.task_id === (t?.task_id ?? null))
          .map((a) => ({ step: a.step, rung: a.rung, class: a.class })),
        policy: { hard_gates_cannot_be_waived: true, risk: s.risk },
      }),
    );
  }

  // --- Policy helpers -------------------------------------------------------------------------

  profile(): Profile {
    return this.p.policy.profiles.profiles[this.s.depth];
  }
  quorum(): number {
    return this.p.policy.profiles.quorum[this.s.risk];
  }
  family(rung: string): string {
    return familyOfRung(this.p.policy, rung);
  }
  rung(rung: string) {
    return this.p.policy.workers.rungs[rung];
  }
  now(): number {
    return this.p.clock.now();
  }

  raiseRisk(to: 'low' | 'medium' | 'high' | 'critical', source: string) {
    const next = maxRisk(this.s.risk, to);
    if (next === this.s.risk) return false;
    const depth = effectiveDepth(this.s.depth, next, this.p.policy.profiles);
    this.append('risk.raised', null, { risk: next, depth, source });
    return true;
  }

  coveredAcs(): string[] {
    return [
      ...this.spec.acceptance_criteria.filter((c) => c.human_reserved).map((c) => c.id),
      ...this.s.human_verified,
    ];
  }

  // --- Eligibility ------------------------------------------------------------------------------

  async refreshHealth(rungs: string[]) {
    for (const r of rungs) {
      const cur = this.health.get(r);
      if (cur && this.now() - cur.at < 60_000) continue;
      const rung = this.rung(r);
      if (!rung) continue;
      const adapter = this.p.adapters[rung.adapter];
      let ok = false;
      let reason: string | null = null;
      if (!adapter) reason = `no adapter ${rung.adapter}`;
      else {
        const h = await adapter.probe(r);
        ok = h.installed && h.version_ok && h.auth !== 'no' && h.quota !== 'exhausted';
        if (!ok)
          reason = !h.installed
            ? 'not_installed'
            : !h.version_ok
              ? 'bad_version'
              : h.auth === 'no'
                ? 'auth_no'
                : 'quota_exhausted';
      }
      if (!cur || cur.ok !== ok || cur.reason !== reason) {
        this.append('eligibility.checked', null, { rung: r, ok, reason });
      }
      this.health.set(r, { ok, reason, at: this.now() });
    }
  }

  rungAvailable(r: string): boolean {
    const h = this.health.get(r);
    if (!h?.ok) return false;
    const q = this.s.quarantine[r];
    if (q && (q.until === null || q.until > this.now())) return false;
    const b = this.s.backoff[r];
    if (b && b.until > this.now()) return false;
    return true;
  }

  // Worker rung: eligible now, not skipped for this step, and leaves a family to review the result.
  pickWriter(ladder: string[], skip: string[], prefer: string | null): string | null {
    const order =
      prefer && ladder.includes(prefer) ? [prefer, ...ladder.filter((x) => x !== prefer)] : ladder;
    for (const r of order) {
      if (skip.includes(r)) continue;
      if (!this.rungAvailable(r)) continue;
      if (rungWouldStrandReview(this.s, this.p.policy, r)) continue;
      return r;
    }
    return null;
  }

  // Read-only rung: eligible now, known family, and outside `excludedFamilies`.
  pickReader(ladder: string[], excludedFamilies: string[], skip: string[]): string | null {
    for (const r of ladder) {
      if (skip.includes(r)) continue;
      if (!this.rungAvailable(r)) continue;
      const f = this.family(r);
      if (f === 'unknown' || excludedFamilies.includes(f)) continue;
      return r;
    }
    return null;
  }

  // Could any configured rung ever qualify, ignoring today's availability?
  anyFamilyCouldQualify(ladder: string[], excludedFamilies: string[]): boolean {
    return ladder.some((r) => {
      const f = this.family(r);
      return f !== 'unknown' && !excludedFamilies.includes(f);
    });
  }

  // --- Agent calls --------------------------------------------------------------------------

  nextAttemptId(): string {
    return `A-${String(this.s.counters.invocations + 1).padStart(4, '0')}`;
  }

  // The synchronous part: intent fsynced before anything starts, as one scheduler step.
  beginAttempt(o: {
    task: TaskRec | null;
    step: string;
    rung: string;
    mode: 'write' | 'read_only';
    cwd: string;
    brief: string;
    n: number;
    intent: 'dispatch.intent' | 'plan.intent' | 'review.intent';
    slot?: number;
    context?: Record<string, unknown>;
    timeout_s?: number;
  }): AttemptRec {
    const attempt_id = this.nextAttemptId();
    const rel = `attempts/${attempt_id}`;
    this.p.store.write(`${rel}/brief.txt`, o.brief);
    const timeout_s = o.timeout_s ?? this.profile().worker_timeout_s;
    this.append(o.intent, o.task?.task_id ?? null, {
      attempt_id,
      step: o.step,
      n: o.n,
      rung: o.rung,
      family: this.family(o.rung),
      out_dir: this.p.store.path(rel),
      cwd: o.cwd,
      mode: o.mode,
      timeout_s,
      deadline_ms: this.now() + timeout_s * 1000,
      slot: o.slot,
      context: o.context,
    });
    return this.s.attempts[attempt_id];
  }

  // The asynchronous part: spawn, record started, then wait in the background.
  async spawnAttempt(
    a: AttemptRec,
    scope: { acs: string[]; files: string[] },
    allowed: string[] = [],
    sessionId: string | null = null,
  ) {
    this.p.failpoint('after_intent_before_spawn');
    const rung = this.rung(a.rung);
    const adapter = this.p.adapters[rung.adapter];
    const req: DispatchRequest = {
      attempt_id: a.attempt_id,
      brief_path: `${a.out_dir}/brief.txt`,
      cwd: a.cwd,
      out_dir: a.out_dir,
      model: rung.model,
      effort: rung.effort ?? rung.variant ?? null,
      mode: a.mode,
      timeout_s: a.timeout_s,
      session_id: sessionId,
      env_allowlist: rung.credential_env,
      meta: {
        task_id: a.task_id,
        step: a.step,
        n: a.n,
        rung: a.rung,
        allowed_paths: allowed,
        scope,
      },
    };
    const slot: Inflight = { adapter, handle: null, done: null, startedMs: this.now() };
    this.inflight.set(a.attempt_id, slot);
    let handle: Inflight['handle'];
    try {
      handle = await adapter.dispatch(req);
    } catch (err) {
      slot.done = spawnFailed(String(err));
      this.notifyWork();
      return false;
    }
    slot.handle = handle;
    this.p.failpoint('after_spawn_before_started');
    this.append('dispatch.started', a.task_id, {
      attempt_id: a.attempt_id,
      pid: handle.pid,
      start_time: handle.start_time,
    });
    this.p.failpoint('after_started_before_child');
    this.watch(a.attempt_id, slot);
    return true;
  }

  watch(attemptId: string, slot: Inflight) {
    slot.adapter.wait(slot.handle as never).then(
      (raw) => {
        slot.done = raw;
        this.notifyWork();
      },
      (err) => {
        slot.done = spawnFailed(String(err));
        this.notifyWork();
      },
    );
    void attemptId;
  }

  notifyWork() {
    this.notified = true;
    for (const fn of this.listeners.splice(0)) fn();
  }

  outcomeOf(attemptId: string): RawOutcome | null {
    return this.inflight.get(attemptId)?.done ?? null;
  }

  // H-SPEC: on every transition out of a worker step, the frozen spec is still the one the run began with.
  checkSpecLock() {
    const text = this.p.store.read('spec.lock');
    const locked = text ? (JSON.parse(text).sha256 as string) : null;
    const res = checkSpecLock(this.s.spec_sha, locked ?? '');
    const current = sha256(canonical(this.spec));
    if (!res.ok || current !== this.s.spec_sha)
      throw new InvariantViolation(`H-SPEC: ${res.ok ? 'the spec in memory changed' : res.detail}`);
  }

  // H-CAP, before each dispatch. A cap stops the next invocation, not the next scheduler tick.
  capBlocks(): boolean {
    if (this.draining) return true;
    const cap = this.capReached();
    if (!cap) return false;
    this.append('cap.reached', null, { cap });
    this.draining = 'budget';
    return true;
  }

  // Records the finish, once. After this the attempt's outcome is on disk and survives a crash.
  recordFinish(a: AttemptRec, raw: RawOutcome) {
    const slot = this.inflight.get(a.attempt_id);
    const wall = slot ? (this.now() - slot.startedMs) / 1000 : 0;
    this.p.store.write(`attempts/${a.attempt_id}/raw.json`, JSON.stringify(raw));
    this.append('dispatch.finished', a.task_id, {
      attempt_id: a.attempt_id,
      status: raw.relay_status,
      exit: raw.exit_code,
      signal: raw.signal,
      wall_clock_s: wall,
    });
    const adapter = slot?.adapter ?? this.p.adapters[this.rung(a.rung).adapter];
    const usage = adapter.usage(raw);
    this.append('usage.recorded', a.task_id, {
      attempt_id: a.attempt_id,
      ...usage,
      wall_clock_s: wall,
    });
    this.inflight.delete(a.attempt_id);
  }

  loadRaw(a: AttemptRec): RawOutcome | null {
    const text = this.p.store.read(`attempts/${a.attempt_id}/raw.json`);
    return text ? JSON.parse(text) : null;
  }

  classifyRaw(a: AttemptRec, raw: RawOutcome): FailureClass {
    const adapter = this.p.adapters[this.rung(a.rung).adapter];
    return adapter.classify(raw);
  }

  // One shared path for failures of read-only agent steps (state machine §4.8).
  planFailure(cls: FailureClass, a: AttemptRec, seenBefore: number, statedReset: number | null) {
    const backoffTries = this.s.backoff[a.rung]?.tries ?? 0;
    return fallbackPlan(
      cls,
      seenBefore,
      this.now(),
      this.p.ids.random(),
      backoffTries,
      statedReset,
    );
  }

  applyFailurePlan(
    a: AttemptRec,
    cls: FailureClass,
    plan: ReturnType<typeof fallbackPlan>,
    key: string,
    nextRung: string | null,
    keepDiff = false,
  ) {
    const backoff =
      plan.backoff_until !== null ? { until: plan.backoff_until, tries: plan.backoff_tries } : null;
    const quarantine =
      plan.quarantine_until !== null
        ? {
            until: plan.quarantine_until === 'run' ? null : plan.quarantine_until,
            reason: plan.quarantine_reason,
            scope: plan.quarantine_until === 'run' ? 'run' : 'time',
          }
        : null;
    this.append('fallback.taken', a.task_id, {
      backoff,
      quarantine,
      attempt_id: a.attempt_id,
      from: a.rung,
      to: plan.retry_same ? a.rung : (nextRung ?? 'none'),
      class: cls,
      step: a.step,
      key,
      next_rung: !plan.retry_same && nextRung !== null,
      not_before: plan.delay_ms ? this.now() + plan.delay_ms : null,
      skip: plan.retry_same ? null : `${a.step}:${a.rung}`,
      keep_diff: keepDiff,
    });
    // Evidence only, after the state change. Applied again on replay, the values are the same.
    if (backoff) this.append('backoff.started', a.task_id, { rung: a.rung, ...backoff });
    if (quarantine) this.append('worker.quarantined', a.task_id, { rung: a.rung, ...quarantine });
    if (plan.flag_owner) {
      const ok = this.safeNotify('AUTH', `${a.rung}: authentication failed`);
      this.append(ok ? 'notification.sent' : 'notification.failed', a.task_id, {
        kind: 'AUTH',
        rung: a.rung,
      });
    }
  }

  anyInflight(): boolean {
    return this.inflight.size > 0;
  }
  setWake(at: number) {
    if (this.wakeAt === null || at < this.wakeAt) this.wakeAt = at;
  }

  // --- Run lifecycle ---------------------------------------------------------------------------

  createRun() {
    const { spec, policy } = { spec: this.spec, policy: this.p.policy };
    this.ledger = new Ledger(this.p.ledgerStore, this.o.runId, () =>
      new Date(this.now()).toISOString(),
    );
    const risk = maxRisk(spec.declared_risk, specRuleRisk(policy.riskRules, spec));
    const depth = effectiveDepth(spec.requested_depth, risk, policy.profiles);
    this.p.store.write('spec.lock', JSON.stringify({ sha256: this.o.specSha }));
    this.append('run.created', null, {
      spec_id: spec.spec_id,
      spec_sha: this.o.specSha,
      policy_sha: this.o.policySha,
      risk,
      depth,
    });
  }

  // Loads the ledger; a truncated tail is recovered, and any other break raises LedgerCorrupt.
  loadForResume() {
    const { events, tornTail } = loadLedger(this.p.ledgerStore);
    this.ledger = new Ledger(
      this.p.ledgerStore,
      this.o.runId,
      () => new Date(this.now()).toISOString(),
      events,
    );
    this.s = replay(events);
    if (tornTail) this.append('ledger.torn_tail_recovered', null, {});
  }

  async resumeRun(opts: {
    acceptPolicy?: boolean;
    extendBudget?: number;
    decision?: Record<string, unknown>;
    policySha: string;
  }) {
    this.append('run.resumed', null, {
      accept_policy: opts.acceptPolicy ? opts.policySha : undefined,
      extend_budget: opts.extendBudget,
    });
    try {
      await reconcileOpenAttempts(this);
      if (this.s.pending_decision) this.completeDecision();
    } catch (err) {
      if (err instanceof SimulatedKill) throw err;
      await this.failFromError(err);
      return;
    }
    if (opts.decision) this.applyDecision(opts.decision);
    if (PAUSED.includes(this.s.state)) {
      const to = this.s.resume_to ?? 'EXECUTING';
      this.draining = null;
      this.runTo(to, 'resume');
    }
  }

  async loop(): Promise<RunExit> {
    try {
      for (;;) {
        this.wakeAt = null;
        this.pollControl();
        await this.enforceDeadlines();
        this.heartbeat();
        this.observe(() => this.p.observer?.poll());
        const progressed = await this.step();
        if (RUN_STOPPING.includes(this.s.state) && !this.shouldContinueAfterStop()) break;
        if (!progressed) await this.idle();
      }
    } catch (err) {
      if (err instanceof SimulatedKill) throw err;
      await this.failFromError(err);
    }
    return this.finish();
  }

  private shouldContinueAfterStop(): boolean {
    return (
      this.s.state === 'READY_FOR_HUMAN_MERGE' &&
      this.spec.publish !== undefined &&
      this.p.publisher !== null
    );
  }

  private async failFromError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      !(err instanceof InvariantViolation) &&
      !(err instanceof LedgerCorrupt) &&
      !(err instanceof StuckRun)
    ) {
      // A defect is still a run failure, with its message on record.
    }
    if (this.ledger && !RUN_STOPPING.includes(this.s.state)) {
      this.append('invariant.violation', null, { message });
      await this.stopEverything();
      this.append('run.state_changed', null, {
        from: this.s.state,
        to: 'FAILED',
        trigger: 'invariant',
        reason: message,
      });
    } else if (this.ledger) {
      this.append('invariant.violation', null, { message });
    }
  }

  private async finish(): Promise<RunExit> {
    await this.drainObserver();
    const done = RUN_STOPPING.includes(this.s.state);
    if (done) {
      await this.cleanupWorktrees();
      this.p.finishRun?.(this);
    }
    this.project();
    return { state: this.s.state, code: EXIT[this.s.state] ?? 1 };
  }

  // Bounded by the end-of-run wait. An observer that never settles can't hold the run open.
  private async drainObserver() {
    if (!this.p.observer) return;
    const deadline = this.now() + this.p.policy.settings.timeouts.shadow_end_wait_s * 1000;
    let settled = false;
    const done = Promise.resolve()
      .then(() => this.p.observer?.drain())
      .catch((err) => {
        this.append('shadow.unavailable', null, {
          decision_id: null,
          status: 'SHADOW_UNAVAILABLE',
          class: 'OBSERVER_ERROR',
          detail: String(err),
        });
      })
      .finally(() => {
        settled = true;
        this.notifyWork();
      });
    while (!settled && this.now() < deadline) {
      await this.p.clock.idle(
        deadline,
        () => settled,
        (fn) => this.listeners.push(fn),
      );
    }
    if (settled) await done;
  }

  private async cleanupWorktrees() {
    if (
      !['READY_FOR_HUMAN_MERGE', 'CANCELLED', 'MOCK_RUN_COMPLETE', 'PR_OPENED'].includes(
        this.s.state,
      )
    )
      return;
    for (const t of Object.values(this.s.tasks)) {
      if (t.worktree) await this.p.git.removeWorktree(t.worktree);
    }
    if (this.s.integration.worktree) await this.p.git.removeWorktree(this.s.integration.worktree);
  }

  project() {
    this.p.projectRun?.(this);
  }

  // A re-attached relay past its hard deadline stops being trusted (state machine §7.4). It goes down
  // the shared kill-and-confirm path, even if the adapter's cancel never settles.
  private async enforceDeadlines() {
    for (const [id, slot] of this.inflight) {
      const a = this.s.attempts[id];
      if (!slot.reattached || slot.done || !a) continue;
      const limit = a.deadline_ms + 60_000;
      if (this.now() < limit) {
        this.setWake(limit);
        continue;
      }
      this.append('cancel.sent', a.task_id, { attempt_id: id, reason: 'deadline' });
      if (slot.handle)
        void Promise.resolve(slot.adapter.cancel(slot.handle as never)).catch(() => {});
      await sweepAttempt(this, a);
      slot.done = {
        ...spawnFailed('re-attached relay passed its deadline'),
        spawn_failed: false,
        relay_status: 'timeout',
        exit_code: 143,
        result_present: true,
      };
      this.notifyWork();
    }
  }

  private heartbeat() {
    const now = this.now();
    if (this.lastHeartbeat && now - this.lastHeartbeat > 120_000) {
      this.append('host.sleep_detected', null, { gap_ms: now - this.lastHeartbeat });
    }
    if (now - this.lastHeartbeat >= 60_000) {
      this.append('heartbeat', null, {});
      this.lastHeartbeat = now;
    }
  }

  private pollControl() {
    const req = this.p.readControl();
    if (!req) return;
    this.p.clearControl();
    if (
      RUN_STOPPING.includes(this.s.state) &&
      !PAUSED.includes(this.s.state) &&
      this.s.state !== 'ESCALATION_REQUIRED'
    )
      return;
    if (PAUSED.includes(this.s.state) && req.request === 'pause') return;
    this.append('operator.request_received', null, { request: req.request });
  }

  private async idle() {
    const obs = this.observe(() => this.p.observer?.nextWake() ?? null) ?? null;
    let wake = this.wakeAt;
    if (obs !== null && (wake === null || obs < wake)) wake = obs;
    if (this.notified) {
      this.notified = false;
      return;
    }
    await this.p.clock.idle(
      wake,
      () => this.notified,
      (fn) => this.listeners.push(fn),
    );
    this.notified = false;
  }

  // --- The ordered rules (state machine §2) ---------------------------------------------------------

  private async step(): Promise<boolean> {
    const s = this.s;
    // Raised before a crash, and the run hadn't moved yet.
    if (s.open_escalation && ACTIVE.includes(s.state)) {
      const rec = s.escalations[s.open_escalation];
      this.runTo('ESCALATION_REQUIRED', rec.trigger ?? 'task_escalated', {
        resume_to: s.state,
        reason: `${rec.reason}: ${rec.summary}`,
      });
      return true;
    }
    if (
      s.pending_request === 'cancel' &&
      ![
        'PR_OPENED',
        'FAILED',
        'CANCELLED',
        'MOCK_RUN_COMPLETE',
        'READY_FOR_HUMAN_MERGE',
        'PUSH_BLOCKED',
      ].includes(s.state)
    ) {
      await this.doCancel();
      return true;
    }
    if (s.pending_request === 'pause' && ACTIVE.includes(s.state)) {
      await this.doPause();
      return true;
    }
    if (ACTIVE.includes(s.state)) {
      if (!this.draining) {
        const cap = this.capReached();
        if (cap) {
          this.append('cap.reached', null, { cap });
          this.draining = 'budget';
        }
      }
      if (this.draining) {
        const progressed = await this.drainStep();
        if (!progressed && !this.anyInflight()) {
          const state = this.s.state;
          this.runTo('PAUSED_BUDGET', 'cap_reached', { resume_to: state, reason: 'cap reached' });
          return true;
        }
        return progressed;
      }
      if (this.escalatedWithNoneActive()) {
        this.raiseTaskEscalation();
        return true;
      }
    }
    switch (s.state) {
      case 'CREATED':
        this.runTo('PREFLIGHT', 'lock_acquired');
        return true;
      case 'PREFLIGHT':
        return stepPreflight(this);
      case 'PLANNING':
        return stepPlanning(this);
      case 'EXECUTING': {
        const progressed = await stepTasks(this);
        if (progressed) return true;
        return this.afterTasks();
      }
      case 'INTEGRATING':
        return stepIntegrating(this);
      case 'VERIFYING':
        return stepVerifying(this);
      case 'READY_FOR_HUMAN_MERGE':
        if (this.spec.publish && this.p.publisher) {
          this.runTo('PUSHING', 'publish');
          return true;
        }
        return false;
      case 'PUSHING':
        return stepPushing(this);
      default:
        return false;
    }
  }

  // While a cap holds, nothing new starts. Finished work is still collected and recorded.
  private async drainStep(): Promise<boolean> {
    if (this.s.state === 'EXECUTING' || this.s.state === 'INTEGRATING') return stepTasks(this);
    return false;
  }

  afterTasks(): boolean {
    const tasks = Object.values(this.s.tasks);
    if (tasks.every((t) => t.state === 'TASK_PASSED')) {
      this.runTo('INTEGRATING', 'all_tasks_passed');
      return true;
    }
    return this.pauseIfStuck();
  }

  // Rule 6, or a hole. A hole is a defect, and the fuzz exists to find it.
  pauseIfStuck(): boolean {
    if (this.anyInflight() || this.wakeAt !== null) return false;
    const tasks = Object.values(this.s.tasks);
    const waiting = tasks.some(
      (t) =>
        t.state === 'TASK_WAITING_WORKER' ||
        t.state === 'READY' ||
        t.state === 'DISPATCHING' ||
        t.state === 'REVIEWING' ||
        t.state === 'CHALLENGE_PENDING' ||
        t.state === 'TASK_DISAGREEMENT',
    );
    if (waiting) {
      const state = this.s.state;
      this.runTo('PAUSED_NO_WORKER', 'no_worker', {
        resume_to: state,
        reason: this.noWorkerReason(),
      });
      return true;
    }
    throw new StuckRun(
      `no task can move in ${this.s.state}: ${tasks.map((t) => `${t.task_id}=${t.state}`).join(', ')}`,
    );
  }

  noWorkerReason(): string {
    const reviewable = Object.values(this.s.tasks).some(
      (t) => t.next_step === 'work' || t.next_step === 'repair',
    );
    const stranded =
      reviewable &&
      Object.keys(this.p.policy.workers.rungs).every(
        (r) => !this.rungAvailable(r) || rungWouldStrandReview(this.s, this.p.policy, r),
      );
    return stranded ? 'NO_REVIEWER_FAMILY' : 'no eligible worker';
  }

  private escalatedWithNoneActive(): boolean {
    const tasks = Object.values(this.s.tasks);
    if (!tasks.some((t) => t.state === 'TASK_ESCALATED')) return false;
    if (this.anyInflight()) return false;
    return !tasks.some(
      (t) => ACTIVE_TASK.includes(t.state) && !(t.state === 'REVIEWING' && !this.canStillMove(t)),
    );
  }
  private canStillMove(_t: TaskRec) {
    return true;
  }

  private raiseTaskEscalation() {
    // Dependents are blocked first, so the record of the stop doesn't depend on scheduling order.
    let moved = true;
    while (moved) {
      moved = false;
      for (const x of Object.values(this.s.tasks)) {
        if (x.state !== 'PENDING') continue;
        const blocked = x.spec.depends_on.some((d) =>
          ['TASK_ESCALATED', 'TASK_BLOCKED'].includes(this.s.tasks[d]?.state),
        );
        if (blocked) {
          this.taskTo(x, 'TASK_BLOCKED', 'dep_failed');
          moved = true;
        }
      }
    }
    const t = Object.values(this.s.tasks).find((x) => x.state === 'TASK_ESCALATED') as TaskRec;
    const raw = t.escalation_reason ?? 'REPAIR_EXHAUSTED';
    const reason = (
      raw === 'SYNTHETIC_MERGE_CONFLICT' ? 'MERGE_CONFLICT' : raw
    ) as EscalationReason;
    this.escalate(reason, t, `${t.task_id}: ${reason}`, 'task_escalated', {
      synthetic: raw === 'SYNTHETIC_MERGE_CONFLICT',
    });
  }

  escalate(
    reason: EscalationReason,
    t: TaskRec | null,
    summary: string,
    trigger: string,
    opts: { synthetic?: boolean } = {},
  ) {
    if (this.s.open_escalation) return;
    const id = `E-${Object.keys(this.s.escalations).length + 1}`;
    const synthetic = opts.synthetic ?? false;
    const record = {
      schema: 'escalation.v1',
      id,
      reason,
      task_id: t?.task_id ?? null,
      summary,
      evidence: [],
      options: optionsFor(reason, t?.task_id ?? null, { synthetic }),
      trigger,
    };
    this.p.store.write(`escalations/${id}.json`, JSON.stringify(record, null, 2));
    this.decide('DP-ESCALATE', t, 'escalate', reason, this.s.state, 'ESCALATION_REQUIRED');
    this.append('escalation.raised', t?.task_id ?? null, { record });
    const state = this.s.state;
    this.runTo('ESCALATION_REQUIRED', trigger, {
      resume_to: state,
      reason: `${reason}: ${summary}`,
    });
  }

  capReached(): string | null {
    const c = this.p.policy.settings.caps;
    const s = this.s;
    const day = this.p.dayUsage();
    const checks: [string, number, number][] = [
      ['run.invocations', s.counters.invocations, c.run.invocations + s.extended_budget],
      ['run.wall_clock_s', s.worker_wall_s, c.run.wall_clock_s + s.extended_budget * 3600],
      ['run.usd', s.usage.cost_usd, c.run.usd + s.extended_budget],
      [
        'day.invocations',
        day.invocations + s.counters.invocations,
        c.day.invocations + s.extended_budget,
      ],
      [
        'day.wall_clock_s',
        day.wall_clock_s + s.worker_wall_s,
        c.day.wall_clock_s + s.extended_budget * 3600,
      ],
      ['day.usd', day.usd + s.usage.cost_usd, c.day.usd + s.extended_budget],
    ];
    if (c.run.tokens !== null) checks.push(['run.tokens', s.usage.tokens, c.run.tokens]);
    for (const [name, used, cap] of checks) {
      if (used >= cap * 0.8 && !s.cap_warned.includes(name))
        this.append('cap.warning', null, { cap: name, used, limit: cap });
      if (used >= cap) return name;
    }
    return null;
  }

  // --- Operator stops ---------------------------------------------------------------------------

  async cancelInflight() {
    for (const [id, slot] of [...this.inflight]) {
      const a = this.s.attempts[id];
      if (slot.handle && !slot.done) {
        this.append('cancel.sent', a?.task_id ?? null, { attempt_id: id });
        await slot.adapter.cancel(slot.handle as never);
        const raw = await slot.adapter.wait(slot.handle as never);
        slot.done = { ...raw, cancelled_by_us: true };
      }
      if (a && !a.finished) this.recordFinish(a, slot.done ?? spawnFailed('cancelled'));
      if (a) await sweepAttempt(this, a);
      if (a && a.class === null) {
        this.append('dispatch.classified', a.task_id, { attempt_id: id, class: 'CANCELLED' });
        this.releaseIfUnretained(a);
      }
    }
    this.inflight.clear();
    // Including attempts from before a crash, which aren't in the in-memory map.
    for (const a of Object.values(this.s.attempts)) {
      if (a.fenced || a.swept) continue;
      await sweepAttempt(this, a);
      if (a.class === null) {
        this.append('dispatch.classified', a.task_id, {
          attempt_id: a.attempt_id,
          class: 'CANCELLED',
        });
        this.releaseIfUnretained(a);
      }
    }
  }

  releaseIfUnretained(a: AttemptRec) {
    // Liveness first: a released family or a reused worktree must have no writer left.
    if (!this.s.attempts[a.attempt_id].swept)
      throw new InvariantViolation(`release of ${a.attempt_id} before its sweep`);
    if (a.mode === 'write' && !a.retained && !a.released) {
      this.append('reservation.released', a.task_id, { attempt_id: a.attempt_id });
    }
  }

  private async stopEverything() {
    // Already failing. One attempt's failure to stop mustn't leave another's writer unswept.
    for (let tries = 0; tries < 3; tries++) {
      try {
        await this.cancelInflight();
        return;
      } catch {
        // Try again; the failed attempt is recorded, and its sweep throws only if it won't die.
      }
    }
  }

  private async doCancel() {
    await this.cancelInflight();
    if (this.s.state === 'INTEGRATING' || this.s.state === 'VERIFYING') {
      this.append('merge.aborted', null, { tip: this.s.integration.tip });
    }
    for (const t of Object.values(this.s.tasks)) {
      if (t.state !== 'TASK_CANCELLED') this.taskTo(t, 'TASK_CANCELLED', 'run_cancelling');
    }
    this.runTo('CANCELLED', 'cancel', { reason: 'operator cancelled' });
  }

  private async doPause() {
    await this.cancelInflight();
    for (const t of Object.values(this.s.tasks)) {
      switch (t.state) {
        case 'WORKING':
          this.taskTo(t, 'COLLECTING', 'relay_exited');
          this.taskTo(t, 'TASK_WAITING_WORKER', 'pausing');
          break;
        case 'DISPATCHING':
          this.taskTo(t, 'COLLECTING', 'spawn_failed');
          this.taskTo(t, 'TASK_WAITING_WORKER', 'pausing');
          break;
        case 'COLLECTING':
          this.taskTo(t, 'TASK_WAITING_WORKER', 'pausing');
          break;
        case 'GATING':
          this.taskTo(t, 'TASK_WAITING_WORKER', 'pausing', { next_step: 'gate' });
          break;
        case 'REVIEWING':
          this.taskTo(t, 'TASK_WAITING_WORKER', 'pausing', { next_step: 'review' });
          break;
        case 'CHALLENGE_PENDING':
          this.taskTo(t, 'TASK_WAITING_WORKER', 'pausing', { next_step: 'challenge' });
          break;
        case 'TASK_DISAGREEMENT':
          this.taskTo(t, 'TASK_WAITING_WORKER', 'pausing', { next_step: 'adjudicate' });
          break;
        default:
          break;
      }
    }
    const state = this.s.state;
    this.runTo('PAUSED_OPERATOR', 'operator_pause', {
      resume_to: state,
      reason: 'operator paused',
    });
  }

  // --- Owner decisions (state machine §5) ---------------------------------------------------------

  applyDecision(d: Record<string, any>) {
    const id = this.s.open_escalation;
    if (!id) throw new DecisionRefused('no open escalation');
    const rec = this.s.escalations[id];
    if (d.escalation_id !== id)
      throw new DecisionRefused(`decision is for ${d.escalation_id}, open is ${id}`);
    if (!rec.options.some((o: any) => o.id === d.option_id)) {
      throw new DecisionRefused(`${d.option_id} isn't an option for ${rec.reason}`);
    }
    const resetIntegrated = d.option_id === 'retry_integration';
    this.append('operator.decision', rec.task_id, {
      escalation_id: id,
      option_id: d.option_id,
      note: d.note,
      new_information: d.new_information,
      authority_exercised: d.authority_exercised,
      target: d.target ?? rec.task_id,
      reset_integrated_repairs: resetIntegrated,
    });
    this.completeDecision();
  }

  // Runs after the decision is on the ledger, and again on resume if a crash fell mid-way. Each step
  // checks state first, so repeating it changes nothing.
  completeDecision() {
    const d = this.s.pending_decision;
    if (!d) return;
    const rec = this.s.escalations[d.escalation_id];
    const t: TaskRec | null = rec.task_id ? this.s.tasks[rec.task_id] : null;
    const escalated = t?.state === 'TASK_ESCALATED';
    const back = (this.s.resume_to ?? 'EXECUTING') as RunStateName;
    const trigger = (to: RunStateName) =>
      to === 'INTEGRATING'
        ? 'decision_integrating'
        : to === 'VERIFYING'
          ? 'decision_verifying'
          : 'decision_executing';
    switch (d.option_id) {
      case 'abandon': {
        for (const x of Object.values(this.s.tasks)) {
          if (x.state !== 'TASK_CANCELLED') this.taskTo(x, 'TASK_CANCELLED', 'run_cancelling');
        }
        this.runTo('CANCELLED', 'decision_abandon', { reason: 'owner abandoned' });
        return;
      }
      case 'retry_task': {
        if (escalated)
          this.taskTo(t as TaskRec, 'READY', 'owner_retry', {
            reset: true,
            escalation_reason: null,
            note: d.note,
          });
        this.runTo('EXECUTING', 'decision_executing', { reason: d.note });
        return;
      }
      case 'retry_integration': {
        if (t && escalated) this.taskTo(t, 'TASK_CANCELLED', 'run_cancelling');

        this.runTo('INTEGRATING', 'decision_integrating', { reason: d.note });
        return;
      }
      case 'waive':
      case 'override': {
        const task = t as TaskRec;
        this.recordOwnerWaivers(task, d.option_id);
        const noSnapshot = task.is_integration && task.snapshots.length === 0;
        if (!escalated) {
          // Already moved before the crash.
        } else if (noSnapshot)
          this.taskTo(task, 'TASK_PASSED', 'owner_ruled_no_snapshot', { escalation_reason: null });
        else if (d.option_id === 'waive')
          this.taskTo(task, 'GATING', 'owner_waive', {
            next_step: 'gate',
            escalation_reason: null,
          });
        else
          this.taskTo(task, 'REVIEWING', 'owner_override', {
            next_step: 'review',
            escalation_reason: null,
          });
        this.runTo(back, trigger(back), { reason: d.note });
        return;
      }
      case 'reject': {
        if (rec.reason === 'HUMAN_IRREVERSIBLE_GATE') {
          for (const x of Object.values(this.s.tasks)) {
            if (x.state !== 'TASK_CANCELLED') this.taskTo(x, 'TASK_CANCELLED', 'run_cancelling');
          }
          this.runTo('CANCELLED', 'decision_reject', { reason: 'owner rejected' });
          return;
        }
        const task = t as TaskRec;
        if (escalated)
          this.taskTo(task, 'REPAIR_PENDING', 'owner_reject', {
            next_step: 'repair',
            reset_repairs: true,
            escalation_reason: null,
          });
        this.runTo(back, trigger(back), { reason: d.note });
        return;
      }
      case 'mark_human_verified':
        this.runTo('VERIFYING', 'decision_verifying', { reason: 'owner verified a criterion' });
        return;
      case 'approve':
        this.runTo('READY_FOR_HUMAN_MERGE', 'decision_approve', { reason: 'owner approved' });
        return;
      default:
        throw new DecisionRefused(`unknown option ${d.option_id}`);
    }
  }

  hasWaiver(
    scope: string,
    r: {
      gate_id?: string | null;
      signature_element?: string | null;
      finding_fingerprint?: string | null;
      criterion?: string | null;
      semantic_check?: string | null;
    },
  ) {
    return this.s.waivers.some(
      (w: any) =>
        w.scope === scope &&
        (w.resolves.gate_id ?? null) === (r.gate_id ?? null) &&
        (w.resolves.signature_element ?? null) === (r.signature_element ?? null) &&
        (w.resolves.finding_fingerprint ?? null) === (r.finding_fingerprint ?? null) &&
        (w.resolves.criterion ?? null) === (r.criterion ?? null) &&
        (w.resolves.semantic_check ?? null) === (r.semantic_check ?? null),
    );
  }

  private recordOwnerWaivers(t: TaskRec, option: string) {
    const lastRun = t.gate_runs[t.gate_runs.length - 1];
    const tree = lastRun?.tree ?? t.snapshots[t.snapshots.length - 1]?.tree ?? '0'.repeat(40);
    const nextId = () => `W-${this.s.waivers.length + 1}`;
    if (option === 'waive') {
      for (const r of lastRun?.results ?? []) {
        if (r.status !== 'FAIL' || !r.soft) continue;
        for (const el of (r as any).uncovered ?? []) {
          if (this.hasWaiver(t.task_id, { gate_id: r.id, signature_element: el })) continue;
          this.append('waiver.recorded', t.task_id, {
            waiver: gateWaiver(nextId(), r.id, el, null, t.task_id, tree),
          });
        }
      }
    } else {
      const last = t.reviews[t.reviews.length - 1];
      this.addFindingWaivers(t, last?.review_id ?? null, null, tree);
    }
  }

  // `only`, when given, limits the ruling to those fingerprints: a ruling on one finding waives no other.
  addFindingWaivers(
    t: TaskRec,
    reviewId: string | null,
    disagreementId: string | null,
    tree: string,
    only: string[] | null = null,
  ) {
    const review = reviewId
      ? JSON.parse(this.p.store.read(`reviews/${reviewId}.json`) ?? 'null')
      : null;
    if (!review) return;
    const blocking = review.findings.flatMap((f: any, i: number) =>
      f.severity === 'blocker' || f.severity === 'major' ? [i] : [],
    );
    for (const i of blocking) {
      const f = review.findings[i];
      if (only && !only.includes(f.fingerprint)) continue;
      const links: { criterion: string | null; semantic_check: string | null }[] = [];
      for (const c of review.criteria)
        if (c.verdict === 'FAIL' && c.finding_refs.includes(i))
          links.push({ criterion: c.ac, semantic_check: null });
      for (const [name, sc] of Object.entries<any>(review.semantic_checks)) {
        if (sc.verdict === 'FAIL' && sc.finding_refs.includes(i))
          links.push({ criterion: null, semantic_check: name });
      }
      for (const link of links.length ? links : [{ criterion: null, semantic_check: null }]) {
        if (this.hasWaiver(t.task_id, { finding_fingerprint: f.fingerprint, ...link })) continue;
        this.append('waiver.recorded', t.task_id, {
          waiver: {
            schema: 'waiver.v1',
            id: `W-${this.s.waivers.length + 1}`,
            kind: 'finding',
            gate_id: null,
            finding_fingerprint: f.fingerprint,
            signature: null,
            disagreement_id: disagreementId,
            scope: t.task_id,
            resolves: {
              gate_id: null,
              signature_element: null,
              finding_fingerprint: f.fingerprint,
              criterion: link.criterion,
              semantic_check: link.semantic_check,
            },
            review_id: reviewId,
            tree_at_ruling: tree,
          },
        });
      }
    }
  }

  authorsIntegrated() {
    return authorsIntegrated(this.s);
  }
  familyOfModel(model: string) {
    return familyOfModel(this.p.policy, model);
  }
}

export function gateWaiver(
  id: string,
  gateId: string,
  element: string,
  disagreementId: string | null,
  scope: string,
  tree: string,
) {
  return {
    schema: 'waiver.v1',
    id,
    kind: 'gate',
    gate_id: gateId,
    finding_fingerprint: null,
    signature: element,
    disagreement_id: disagreementId,
    scope,
    resolves: {
      gate_id: gateId,
      signature_element: element,
      finding_fingerprint: null,
      criterion: null,
      semantic_check: null,
    },
    review_id: null,
    tree_at_ruling: tree,
  };
}

export class StuckRun extends Error {}
export class DecisionRefused extends Error {}

export function spawnFailed(detail: string): RawOutcome {
  return {
    relay_status: null,
    exit_code: null,
    signal: null,
    final_message: '',
    stderr_tail: detail,
    session_id: null,
    model_reported: null,
    usage: null,
    result_present: false,
    transport_provenance: 'mock',
    cancelled_by_us: false,
    spawn_failed: true,
  };
}
