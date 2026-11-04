import type {
  Depth,
  LedgerEvent,
  Plan,
  Risk,
  RunStateName,
  TaskStateName,
  NextStep,
} from '../contracts/index.ts';
import { runRowExists, taskRowExists } from './tables.ts';

export class InvariantViolation extends Error {}

export type AttemptRec = {
  attempt_id: string;
  task_id: string | null;
  step: string;
  n: number;
  rung: string;
  family: string;
  out_dir: string;
  cwd: string;
  mode: 'write' | 'read_only';
  deadline_ms: number;
  timeout_s: number;
  // Set as the attempt moves on.
  started: boolean;
  pid: number | null;
  start_time: string | null;
  child_pid: number | null;
  finished: boolean;
  class: string | null;
  retained: boolean;
  released: boolean;
  fenced: boolean;
  slot?: number;
  context?: Record<string, unknown>;
};

export type SnapshotRec = {
  n: number;
  ref: string;
  commit: string;
  tree: string;
  family: string | null;
  rung: string | null;
  claims: unknown[];
  disputes: unknown[];
};

export type TaskRec = {
  task_id: string;
  spec: {
    goal: string;
    lane: string;
    allowed_paths: string[];
    forbidden_paths: string[];
    acceptance_criteria: string[];
    required_tests: string[];
    depends_on: string[];
  };
  is_integration: boolean;
  conflict_of: string | null;
  state: TaskStateName;
  next_step: NextStep;
  base_commit: string | null;
  worktree: string | null;
  branch: string | null;
  commit: string | null;
  rung: string | null;
  tried_rungs: string[];
  attempts: number;
  repairs: number;
  repair_rung_switches: number;
  stalls: number;
  timeouts: number;
  rung_retries: Record<string, number>;
  snapshots: SnapshotRec[];
  retained_families: string[];
  gate_runs: GateRun[];
  reviews: ReviewRec[];
  open_findings: unknown[];
  stall_history: { tree: string | null; signature: string | null; stall_keys: string[] }[];
  adjudications: number;
  adjudicated: string[];
  reasked: Record<string, number>;
  reviewer_rung: string | null;
  waiting_since: number | null;
  escalation_reason: string | null;
  reset_generation: number;
  needs_reset: boolean;
  quarantined_rungs: string[];
  discarded_evidence: number;
};

export type GateRun = {
  tree: string;
  attempt_n: number;
  results: {
    id: string;
    status: string;
    signature?: string | null;
    soft: boolean;
    detail?: string;
  }[];
};
export type ReviewRec = {
  review_id: string;
  tree: string;
  verdict: string;
  effective: string;
  rung: string;
  family: string;
  slot: number;
  fingerprints: string[];
  stall_keys: string[];
  mock: boolean;
};

export type WaiverRec = Record<string, any> & { id: string; scope: string };

export type RunR = {
  run_id: string;
  spec_id: string;
  spec_sha: string;
  policy_sha: string;
  state: RunStateName;
  resume_to: RunStateName | null;
  reason: string | null;
  risk: Risk;
  depth: Depth;
  plan: Plan | null;
  plan_reviews_failed: number;
  plan_rejected: number;
  tasks: Record<string, TaskRec>;
  task_order: string[];
  attempts: Record<string, AttemptRec>;
  integration: {
    branch: string | null;
    worktree: string | null;
    tip: string | null;
    merged: string[];
  };
  integrated_repairs: number;
  next_tint: number;
  verify: { generation: number; passed_stages: string[]; tree: string | null };
  mock_review_seen: boolean;
  authors_integrated: string[];
  waivers: WaiverRec[];
  disagreements: Record<string, any>;
  escalations: Record<string, any>;
  open_escalation: string | null;
  human_verified: string[];
  approved_gate: boolean;
  quarantine: Record<string, { until: number | null; reason: string; scope: string }>;
  backoff: Record<string, { until: number; tries: number }>;
  counters: { invocations: number; repairs: number; fallbacks: number; shadow_invocations: number };
  usage: {
    measured: number;
    total: number;
    tokens: number;
    cost_usd: number;
    usd_measured: number;
  };
  worker_wall_s: number;
  publish: {
    frozen_sha: string | null;
    gate_ok: boolean;
    pushed: boolean;
    verified: boolean;
    pr_intent: boolean;
    pr_url: string | null;
    pr_validated: boolean;
    accepted_base: string | null;
    last_error: string | null;
  };
  pending_request: 'pause' | 'cancel' | null;
  shadow: {
    decision_points: number;
    recorded: number;
    matched: number;
    unavailable: number;
    skipped: number;
    invocations: number;
  };
  last_decision: number;
  cap_warned: string[];
  last_heartbeat_at: string | null;
  extended_budget: number;
  policy_accepts: string[];
};

export function initialRun(): RunR {
  return {
    run_id: '',
    spec_id: '',
    spec_sha: '',
    policy_sha: '',
    state: 'CREATED',
    resume_to: null,
    reason: null,
    risk: 'low',
    depth: 'QUICK',
    plan: null,
    plan_reviews_failed: 0,
    plan_rejected: 0,
    tasks: {},
    task_order: [],
    attempts: {},
    integration: { branch: null, worktree: null, tip: null, merged: [] },
    integrated_repairs: 0,
    next_tint: 1,
    verify: { generation: 0, passed_stages: [], tree: null },
    mock_review_seen: false,
    authors_integrated: [],
    waivers: [],
    disagreements: {},
    escalations: {},
    open_escalation: null,
    human_verified: [],
    approved_gate: false,
    quarantine: {},
    backoff: {},
    counters: { invocations: 0, repairs: 0, fallbacks: 0, shadow_invocations: 0 },
    usage: { measured: 0, total: 0, tokens: 0, cost_usd: 0, usd_measured: 0 },
    worker_wall_s: 0,
    publish: {
      frozen_sha: null,
      gate_ok: false,
      pushed: false,
      verified: false,
      pr_intent: false,
      pr_url: null,
      pr_validated: false,
      accepted_base: null,
      last_error: null,
    },
    pending_request: null,
    shadow: {
      decision_points: 0,
      recorded: 0,
      matched: 0,
      unavailable: 0,
      skipped: 0,
      invocations: 0,
    },
    last_decision: 0,
    cap_warned: [],
    last_heartbeat_at: null,
    extended_budget: 0,
    policy_accepts: [],
  };
}

export function newTask(taskId: string, spec: TaskRec['spec'], isIntegration: boolean): TaskRec {
  return {
    task_id: taskId,
    spec,
    is_integration: isIntegration,
    conflict_of: null,
    state: 'PENDING',
    next_step: 'work',
    base_commit: null,
    worktree: null,
    branch: null,
    commit: null,
    rung: null,
    tried_rungs: [],
    attempts: 0,
    repairs: 0,
    repair_rung_switches: 0,
    stalls: 0,
    timeouts: 0,
    rung_retries: {},
    snapshots: [],
    retained_families: [],
    gate_runs: [],
    reviews: [],
    open_findings: [],
    stall_history: [],
    adjudications: 0,
    adjudicated: [],
    reasked: {},
    reviewer_rung: null,
    waiting_since: null,
    escalation_reason: null,
    reset_generation: 0,
    needs_reset: false,
    quarantined_rungs: [],
    discarded_evidence: 0,
  };
}

function task(s: RunR, id: string | null): TaskRec {
  const rec = id ? s.tasks[id] : undefined;
  if (!rec) throw new InvariantViolation(`event names unknown task ${id}`);
  return rec;
}

// Pure: mutates only the structured clone taken by `reduce`. shadow.* events touch only s.shadow.
function apply(s: RunR, ev: LedgerEvent): void {
  const d = ev.data as Record<string, any>;
  switch (ev.type) {
    case 'run.created':
      s.run_id = ev.run_id;
      s.spec_id = d.spec_id;
      s.spec_sha = d.spec_sha;
      s.policy_sha = d.policy_sha;
      s.risk = d.risk;
      s.depth = d.depth;
      return;
    case 'run.state_changed': {
      if (d.from !== s.state) {
        throw new InvariantViolation(`run transition from ${d.from}, but state is ${s.state}`);
      }
      if (!runRowExists(d.from, d.trigger, d.to)) {
        throw new InvariantViolation(`illegal run transition ${d.from} --${d.trigger}--> ${d.to}`);
      }
      s.state = d.to;
      s.reason = d.reason ?? null;
      if (d.resume_to !== undefined) s.resume_to = d.resume_to;
      else if (d.trigger === 'resume') s.resume_to = null;
      if (d.to === 'VERIFYING') {
        s.verify = { generation: s.verify.generation + 1, passed_stages: [], tree: null };
      }
      if (d.trigger === 'cancel' || d.trigger === 'operator_pause') s.pending_request = null;
      return;
    }
    case 'task.state_changed': {
      if (d.from === null) {
        if (s.tasks[ev.task_id as string]) {
          throw new InvariantViolation(`task ${ev.task_id} opened twice`);
        }
        const t = newTask(ev.task_id as string, d.spec, Boolean(d.is_integration));
        t.state = d.to;
        t.next_step = d.next_step ?? 'work';
        t.conflict_of = d.conflict_of ?? null;
        t.base_commit = d.base_commit ?? null;
        s.tasks[t.task_id] = t;
        s.task_order.push(t.task_id);
        if (d.is_integration && d.counted !== false) {
          s.next_tint += 1;
          s.integrated_repairs += d.charge === false ? 0 : 1;
        }
        return;
      }
      const t = task(s, ev.task_id);
      if (d.from !== t.state) {
        throw new InvariantViolation(`task ${t.task_id} from ${d.from}, but state is ${t.state}`);
      }
      if (!taskRowExists(d.from, d.trigger, d.to)) {
        throw new InvariantViolation(`illegal task transition ${d.from} --${d.trigger}--> ${d.to}`);
      }
      t.state = d.to;
      if (d.next_step) t.next_step = d.next_step;
      if (d.escalation_reason !== undefined) t.escalation_reason = d.escalation_reason;
      if (d.to === 'TASK_WAITING_WORKER') t.waiting_since = ev.seq;
      if (d.commit !== undefined) t.commit = d.commit;
      if (d.reset) {
        t.attempts = 0;
        t.repairs = 0;
        t.repair_rung_switches = 0;
        t.stalls = 0;
        t.timeouts = 0;
        t.rung_retries = {};
        t.tried_rungs = [];
        t.snapshots = [];
        t.retained_families = [];
        t.gate_runs = [];
        t.reviews = [];
        t.open_findings = [];
        t.stall_history = [];
        t.reasked = {};
        t.adjudications = 0;
        t.adjudicated = [];
        t.commit = null;
        t.reviewer_rung = null;
        t.next_step = 'work';
        t.reset_generation += 1;
        t.needs_reset = true;
      }
      if (d.reset_repairs) {
        t.repairs = 0;
        t.repair_rung_switches = 0;
        t.stalls = 0;
      }
      return;
    }
    case 'risk.raised':
      s.risk = d.risk;
      s.depth = d.depth;
      return;
    case 'plan.accepted':
      s.plan = d.plan;
      return;
    case 'plan.rejected':
      s.plan_rejected += 1;
      if (d.kind === 'review_failed') s.plan_reviews_failed += 1;
      return;
    case 'worktree.created': {
      const t = task(s, ev.task_id);
      t.worktree = d.path;
      t.base_commit = d.base_commit;
      t.branch = d.branch ?? t.branch;
      t.needs_reset = false;
      return;
    }
    case 'dispatch.intent':
    case 'plan.intent':
    case 'review.intent':
    case 'shadow.intent': {
      if (ev.type === 'shadow.intent') {
        s.shadow.invocations += 1;
        s.counters.shadow_invocations += 1;
        return;
      }
      const rec: AttemptRec = {
        attempt_id: d.attempt_id,
        task_id: ev.task_id,
        step: d.step,
        n: d.n,
        rung: d.rung,
        family: d.family,
        out_dir: d.out_dir,
        cwd: d.cwd,
        mode: d.mode,
        deadline_ms: d.deadline_ms,
        timeout_s: d.timeout_s,
        started: false,
        pid: null,
        start_time: null,
        child_pid: null,
        finished: false,
        class: null,
        retained: false,
        released: false,
        fenced: false,
        slot: d.slot,
        context: d.context,
      };
      s.attempts[rec.attempt_id] = rec;
      s.counters.invocations += 1;
      if (ev.task_id && s.tasks[ev.task_id] && ev.type === 'dispatch.intent') {
        const t = s.tasks[ev.task_id];
        t.attempts += 1;
        t.rung = d.rung;
        if (!t.tried_rungs.includes(d.rung)) t.tried_rungs.push(d.rung);
        if (d.step === 'repair' && d.charge_repair) {
          t.repairs += 1;
          s.counters.repairs += 1;
        }
      }
      return;
    }
    case 'dispatch.started': {
      const a = s.attempts[d.attempt_id];
      if (!a) throw new InvariantViolation(`started for unknown attempt ${d.attempt_id}`);
      a.started = true;
      a.pid = d.pid ?? null;
      a.start_time = d.start_time ?? null;
      return;
    }
    case 'dispatch.child_recorded': {
      const a = s.attempts[d.attempt_id];
      if (a) a.child_pid = d.child_pid ?? null;
      return;
    }
    case 'dispatch.finished': {
      const a = s.attempts[d.attempt_id];
      if (!a) throw new InvariantViolation(`finished for unknown attempt ${d.attempt_id}`);
      a.finished = true;
      if (typeof d.wall_clock_s === 'number') s.worker_wall_s += d.wall_clock_s;
      return;
    }
    case 'dispatch.classified': {
      const a = s.attempts[d.attempt_id];
      if (a) a.class = d.class;
      return;
    }
    case 'attempt.result_fenced': {
      const a = s.attempts[d.attempt_id];
      if (a) a.fenced = true;
      return;
    }
    case 'reservation.released': {
      const a = s.attempts[d.attempt_id];
      if (a) a.released = true;
      return;
    }
    case 'snapshot.recorded': {
      const t = task(s, ev.task_id);
      t.snapshots.push({
        n: d.n,
        ref: d.ref,
        commit: d.commit,
        tree: d.tree,
        family: d.family ?? null,
        rung: d.rung ?? null,
        claims: d.claims ?? [],
        disputes: d.disputes ?? [],
      });
      if (d.family && !t.retained_families.includes(d.family)) t.retained_families.push(d.family);
      if (d.attempt_id && s.attempts[d.attempt_id]) s.attempts[d.attempt_id].retained = true;
      return;
    }
    case 'gate.finished': {
      const t = ev.task_id ? s.tasks[ev.task_id] : undefined;
      if (t) {
        t.gate_runs.push({ tree: d.tree, attempt_n: d.attempt_n, results: d.results });
        const last = t.stall_history[t.stall_history.length - 1];
        const sig = (d.results as any[])
          .filter((x) => x.status === 'FAIL')
          .map((x) => `${x.id}:${x.signature ?? ''}`)
          .sort()
          .join(',');
        if (last && last.tree === d.tree) last.signature = sig;
        else t.stall_history.push({ tree: d.tree, signature: sig, stall_keys: [] });
      }
      return;
    }
    case 'evidence.discarded_stale': {
      const t = ev.task_id ? s.tasks[ev.task_id] : undefined;
      if (t) {
        t.discarded_evidence += 1;
        t.gate_runs = t.gate_runs.filter((g) => g.tree !== d.tree || d.keep === true);
      }
      return;
    }
    case 'review.collected': {
      if (d.mock) s.mock_review_seen = true;
      const t = ev.task_id ? s.tasks[ev.task_id] : undefined;
      if (t) {
        t.reviews.push({
          review_id: d.review_id,
          tree: d.tree,
          verdict: d.verdict,
          effective: d.effective,
          rung: d.rung,
          family: d.family,
          slot: d.slot ?? 0,
          fingerprints: d.fingerprints ?? [],
          stall_keys: d.stall_keys ?? [],
          mock: Boolean(d.mock),
        });
        t.reviewer_rung = d.rung;
        t.open_findings = d.findings ?? [];
        const last = t.stall_history[t.stall_history.length - 1];
        if (last && last.tree === d.tree) last.stall_keys = d.stall_keys ?? [];
      }
      return;
    }
    case 'review.invalid': {
      const key = d.key as string;
      const t = ev.task_id ? s.tasks[ev.task_id] : undefined;
      if (t) t.reasked[key] = (t.reasked[key] ?? 0) + 1;
      return;
    }
    case 'repair.requested': {
      const t = task(s, ev.task_id);
      if (d.switch_rung) t.repair_rung_switches += 1;
      return;
    }
    case 'stall.detected': {
      const t = task(s, ev.task_id);
      t.stalls += 1;
      return;
    }
    case 'fallback.taken': {
      s.counters.fallbacks += 1;
      const t = ev.task_id ? s.tasks[ev.task_id] : undefined;
      if (t) {
        const key = d.from as string;
        t.rung_retries[key] = (t.rung_retries[key] ?? 0) + 1;
        if (d.class === 'TIMEOUT') t.timeouts += 1;
        if (d.next_rung) t.rung = d.to;
      }
      return;
    }
    case 'backoff.started':
      s.backoff[d.rung] = { until: d.until, tries: d.tries };
      return;
    case 'worker.quarantined':
      s.quarantine[d.rung] = { until: d.until ?? null, reason: d.reason, scope: d.scope ?? 'run' };
      if (d.task_id && s.tasks[d.task_id]) s.tasks[d.task_id].quarantined_rungs.push(d.rung);
      return;
    case 'disagreement.opened':
      s.disagreements[d.record.id] = d.record;
      return;
    case 'disagreement.adjudicated': {
      const rec = s.disagreements[d.id];
      if (rec) rec.adjudication = d.adjudication;
      const t = rec?.subject?.task_id ? s.tasks[rec.subject.task_id] : undefined;
      if (t && d.counted) {
        t.adjudications += 1;
        for (const k of d.keys ?? []) if (!t.adjudicated.includes(k)) t.adjudicated.push(k);
      }
      return;
    }
    case 'waiver.recorded':
      s.waivers.push(d.waiver);
      return;
    case 'commit.done': {
      const t = task(s, ev.task_id);
      t.commit = d.commit;
      return;
    }
    case 'merge.done':
      s.integration.tip = d.tip;
      s.integration.branch = d.branch ?? s.integration.branch;
      s.integration.worktree = d.worktree ?? s.integration.worktree;
      if (d.task_id && !s.integration.merged.includes(d.task_id)) {
        s.integration.merged.push(d.task_id);
      }
      for (const f of d.authors ?? []) {
        if (!s.authors_integrated.includes(f)) s.authors_integrated.push(f);
      }
      s.verify.passed_stages = [];
      return;
    case 'merge.conflict':
      return;
    case 'tree.identity_checked':
      if (d.stage && s.state === 'VERIFYING' && !s.verify.passed_stages.includes(d.stage)) {
        s.verify.passed_stages.push(d.stage);
        s.verify.tree = d.tree ?? s.verify.tree;
      }
      return;
    case 'usage.recorded': {
      s.usage.total += 1;
      if (d.tokens !== 'unavailable' && d.tokens) {
        s.usage.measured += 1;
        s.usage.tokens += (d.tokens.input ?? 0) + (d.tokens.output ?? 0);
      }
      if (typeof d.cost_usd === 'number') {
        s.usage.cost_usd += d.cost_usd;
        s.usage.usd_measured += 1;
      }
      return;
    }
    case 'cap.warning':
      if (!s.cap_warned.includes(d.cap)) s.cap_warned.push(d.cap);
      return;
    case 'escalation.raised':
      s.escalations[d.record.id] = d.record;
      s.open_escalation = d.record.id;
      return;
    case 'operator.decision': {
      s.open_escalation = null;
      if (d.option_id === 'mark_human_verified' && d.target) s.human_verified.push(d.target);
      if (d.option_id === 'approve') s.approved_gate = true;
      if (s.escalations[d.escalation_id]) s.escalations[d.escalation_id].decision = d;
      if (d.reset_integrated_repairs) s.integrated_repairs = 0;
      return;
    }
    case 'operator.request_received':
      s.pending_request = d.request;
      return;
    case 'run.resumed':
      if (d.accept_policy) {
        s.policy_sha = d.accept_policy;
        s.policy_accepts.push(d.accept_policy);
      }
      if (d.extend_budget) s.extended_budget += d.extend_budget;
      return;
    case 'heartbeat':
      s.last_heartbeat_at = ev.at;
      return;
    case 'push.sha_frozen':
      s.publish.frozen_sha = d.sha;
      s.publish.gate_ok = false;
      return;
    case 'push.gate_failed':
      s.publish.gate_ok = false;
      s.publish.last_error = d.reason ?? null;
      return;
    case 'push.done':
      s.publish.pushed = true;
      return;
    case 'push.verified':
      s.publish.verified = true;
      return;
    case 'push.rejected':
      s.publish.last_error = d.reason ?? null;
      return;
    case 'pr.intent':
      s.publish.pr_intent = true;
      return;
    case 'pr.opened':
      s.publish.pr_url = d.url;
      return;
    case 'pr.validated':
      s.publish.pr_validated = true;
      return;
    case 'pr.validation_failed':
      s.publish.last_error = d.reason ?? null;
      return;
    case 'publish.base_accepted':
      s.publish.accepted_base = d.sha;
      return;
    case 'decision.made':
      // Numbering only. No transition reads this.
      s.last_decision = d.n;
      s.shadow.decision_points += 1;
      return;
    case 'shadow.recorded':
      s.shadow.recorded += 1;
      if (d.match === true) s.shadow.matched += 1;
      return;
    case 'shadow.unavailable':
      if (d.status === 'SHADOW_SKIPPED_BUDGET') s.shadow.skipped += 1;
      else s.shadow.unavailable += 1;
      return;
    default:
      // Remaining event types carry evidence only, and change no state.
      return;
  }
}

export function reduce(prev: RunR, ev: LedgerEvent): RunR {
  const next = structuredClone(prev);
  apply(next, ev);
  return next;
}

export function replay(events: LedgerEvent[]): RunR {
  const s = initialRun();
  for (const ev of events) apply(s, ev);
  return s;
}

// Mutating form for the engine, which appends then applies in one step. Equal to `reduce` by test.
export function applyInPlace(s: RunR, ev: LedgerEvent): void {
  apply(s, ev);
}
