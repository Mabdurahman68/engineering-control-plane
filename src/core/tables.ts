import type { RunStateName, TaskStateName } from '../contracts/index.ts';
import { RUN_STATES, TASK_STATES } from '../contracts/index.ts';

export type Row<S extends string> = { from: S; trigger: string; to: S };

export const RUN_TERMINAL: readonly RunStateName[] = [
  'PR_OPENED',
  'FAILED',
  'CANCELLED',
  'MOCK_RUN_COMPLETE',
];
// READY and PUSH_BLOCKED end a process, but have an exit row for publish.
export const RUN_STOPPING: readonly RunStateName[] = [
  ...RUN_TERMINAL,
  'READY_FOR_HUMAN_MERGE',
  'PUSH_BLOCKED',
  'ESCALATION_REQUIRED',
  'PAUSED_NO_WORKER',
  'PAUSED_BUDGET',
  'PAUSED_OPERATOR',
];
export const PAUSED: readonly RunStateName[] = [
  'PAUSED_NO_WORKER',
  'PAUSED_BUDGET',
  'PAUSED_OPERATOR',
];
const ACTIVE: readonly RunStateName[] = ['PLANNING', 'EXECUTING', 'INTEGRATING', 'VERIFYING'];
const NON_TERMINAL_RUN: readonly RunStateName[] = RUN_STATES.filter(
  (s) => !RUN_TERMINAL.includes(s) && s !== 'READY_FOR_HUMAN_MERGE' && s !== 'PUSH_BLOCKED',
);

function r(from: RunStateName, trigger: string, to: RunStateName): Row<RunStateName> {
  return { from, trigger, to };
}

export const RUN_ROWS: Row<RunStateName>[] = [
  r('CREATED', 'lock_acquired', 'PREFLIGHT'),
  r('PREFLIGHT', 'checks_passed', 'PLANNING'),
  r('PREFLIGHT', 'preflight_failed', 'FAILED'),
  r('PREFLIGHT', 'no_worker', 'PAUSED_NO_WORKER'),
  r('PLANNING', 'plan_valid', 'EXECUTING'),
  r('PLANNING', 'replan', 'PLANNING'),
  r('PLANNING', 'plan_invalid', 'ESCALATION_REQUIRED'),
  r('PLANNING', 'spec_defect', 'ESCALATION_REQUIRED'),
  r('EXECUTING', 'all_tasks_passed', 'INTEGRATING'),
  r('INTEGRATING', 'merges_done', 'VERIFYING'),
  r('INTEGRATING', 'merge_conflict', 'ESCALATION_REQUIRED'),
  r('VERIFYING', 'verified_mock', 'MOCK_RUN_COMPLETE'),
  r('VERIFYING', 'verified', 'READY_FOR_HUMAN_MERGE'),
  r('VERIFYING', 'verified_critical', 'ESCALATION_REQUIRED'),
  r('READY_FOR_HUMAN_MERGE', 'publish', 'PUSHING'),
  r('PUSHING', 'published', 'PR_OPENED'),
  r('PUSHING', 'push_blocked', 'PUSH_BLOCKED'),
  r('PUSH_BLOCKED', 'publish_retry', 'PUSHING'),
  r('VERIFYING', 'repairable', 'INTEGRATING'),
  r('VERIFYING', 'repair_exhausted', 'ESCALATION_REQUIRED'),
  r('VERIFYING', 'hard_gate_breach', 'ESCALATION_REQUIRED'),
  r('VERIFYING', 'unverifiable', 'ESCALATION_REQUIRED'),
  // Rule 5: an escalated task with none active.
  ...ACTIVE.map((s) => r(s, 'task_escalated', 'ESCALATION_REQUIRED')),
  // Rules 3, 4, 6.
  ...ACTIVE.flatMap((s) => [
    r(s, 'operator_pause', 'PAUSED_OPERATOR'),
    r(s, 'cap_reached', 'PAUSED_BUDGET'),
    r(s, 'no_worker', 'PAUSED_NO_WORKER'),
  ]),
  r('PAUSED_NO_WORKER', 'resume', 'PREFLIGHT'),
  ...PAUSED.flatMap((p) => ACTIVE.map((s) => r(p, 'resume', s))),
  // §5: owner decisions.
  r('ESCALATION_REQUIRED', 'decision_abandon', 'CANCELLED'),
  r('ESCALATION_REQUIRED', 'decision_reject', 'CANCELLED'),
  r('ESCALATION_REQUIRED', 'decision_executing', 'EXECUTING'),
  r('ESCALATION_REQUIRED', 'decision_integrating', 'INTEGRATING'),
  r('ESCALATION_REQUIRED', 'decision_verifying', 'VERIFYING'),
  r('ESCALATION_REQUIRED', 'decision_approve', 'READY_FOR_HUMAN_MERGE'),
  // Rules 1, 2: from any non-terminal state.
  ...[...NON_TERMINAL_RUN, 'READY_FOR_HUMAN_MERGE' as const, 'PUSH_BLOCKED' as const].flatMap(
    (s) => [r(s, 'invariant', 'FAILED')],
  ),
  ...NON_TERMINAL_RUN.map((s) => r(s, 'cancel', 'CANCELLED')),
];

function t(from: TaskStateName, trigger: string, to: TaskStateName): Row<TaskStateName> {
  return { from, trigger, to };
}
export const TASK_TERMINAL: readonly TaskStateName[] = ['TASK_CANCELLED'];
const AGENT_STEP_STATES: readonly TaskStateName[] = [
  'REVIEWING',
  'CHALLENGE_PENDING',
  'TASK_DISAGREEMENT',
];

export const TASK_ROWS: Row<TaskStateName>[] = [
  t('PENDING', 'deps_passed', 'READY'),
  t('PENDING', 'dep_failed', 'TASK_BLOCKED'),
  t('READY', 'dispatch', 'DISPATCHING'),
  t('READY', 'no_rung', 'TASK_WAITING_WORKER'),
  t('READY', 'synthetic_conflict', 'TASK_ESCALATED'),
  t('DISPATCHING', 'started', 'WORKING'),
  t('DISPATCHING', 'spawn_failed', 'COLLECTING'),
  t('WORKING', 'relay_exited', 'COLLECTING'),
  t('COLLECTING', 'report_valid', 'GATING'),
  t('COLLECTING', 'malformed', 'DISPATCHING'),
  t('COLLECTING', 'failure_rung_available', 'DISPATCHING'),
  t('COLLECTING', 'failure_no_rung', 'TASK_WAITING_WORKER'),
  t('COLLECTING', 'second_timeout', 'REPAIR_PENDING'),
  t('COLLECTING', 'cancelled', 'TASK_CANCELLED'),
  t('COLLECTING', 'pausing', 'TASK_WAITING_WORKER'),
  t('GATING', 'tree_changed', 'REPAIR_PENDING'),
  t('GATING', 'hard_nonrepairable', 'TASK_ESCALATED'),
  t('GATING', 'hard_repairable', 'REPAIR_PENDING'),
  t('GATING', 'soft_failed', 'CHALLENGE_PENDING'),
  t('GATING', 'dispute_open', 'TASK_DISAGREEMENT'),
  t('GATING', 'gates_passed', 'REVIEWING'),
  t('GATING', 'pausing', 'TASK_WAITING_WORKER'),
  t('GATING', 'cancelled', 'TASK_CANCELLED'),
  t('CHALLENGE_PENDING', 'challenge_filed', 'TASK_DISAGREEMENT'),
  t('CHALLENGE_PENDING', 'no_challenge', 'REPAIR_PENDING'),
  t('REVIEWING', 'reviewers_split', 'TASK_DISAGREEMENT'),
  t('REVIEWING', 'review_passed', 'TASK_PASSED'),
  t('REVIEWING', 'review_failed', 'REPAIR_PENDING'),
  t('REVIEWING', 'risk_raised_more_review', 'REVIEWING'),
  ...AGENT_STEP_STATES.flatMap((s) => [
    t(s, 'no_compliant_rung', 'TASK_WAITING_WORKER'),
    t(s, 'pausing', 'TASK_WAITING_WORKER'),
  ]),
  t('REPAIR_PENDING', 'repair_dispatch', 'DISPATCHING'),
  t('REPAIR_PENDING', 'repair_next_rung', 'DISPATCHING'),
  t('REPAIR_PENDING', 'no_alternate', 'TASK_WAITING_WORKER'),
  t('REPAIR_PENDING', 'repair_exhausted', 'TASK_ESCALATED'),
  t('TASK_DISAGREEMENT', 'gate_waived', 'GATING'),
  t('TASK_DISAGREEMENT', 'finding_overridden', 'REVIEWING'),
  t('TASK_DISAGREEMENT', 'ruled_no_snapshot', 'TASK_PASSED'),
  t('TASK_DISAGREEMENT', 'rejected', 'REPAIR_PENDING'),
  t('TASK_DISAGREEMENT', 'unresolved', 'TASK_ESCALATED'),
  t('TASK_WAITING_WORKER', 'eligible_work', 'DISPATCHING'),
  t('TASK_WAITING_WORKER', 'resume_gate', 'GATING'),
  t('TASK_WAITING_WORKER', 'eligible_review', 'REVIEWING'),
  t('TASK_WAITING_WORKER', 'eligible_challenge', 'CHALLENGE_PENDING'),
  t('TASK_WAITING_WORKER', 'eligible_adjudicate', 'TASK_DISAGREEMENT'),
  t('TASK_PASSED', 'risk_raised', 'REVIEWING'),
  t('TASK_ESCALATED', 'owner_retry', 'READY'),
  t('TASK_ESCALATED', 'owner_reject', 'REPAIR_PENDING'),
  t('TASK_ESCALATED', 'owner_ruled_no_snapshot', 'TASK_PASSED'),
  t('TASK_ESCALATED', 'owner_waive', 'GATING'),
  t('TASK_ESCALATED', 'owner_override', 'REVIEWING'),
  t('TASK_BLOCKED', 'unblocked', 'READY'),
  // A dependent is reset when a reopened dependency gets a new commit.
  ...TASK_STATES.filter((s) => !['PENDING', ...TASK_TERMINAL].includes(s)).map((s) =>
    t(s, 'dependency_reset', 'PENDING'),
  ),
  ...TASK_STATES.filter((s) => !TASK_TERMINAL.includes(s)).map((s) =>
    t(s, 'run_cancelling', 'TASK_CANCELLED'),
  ),
];

function pairKey(from: string, to: string) {
  return `${from}>${to}`;
}
function triggerKey(from: string, trigger: string) {
  return `${from}|${trigger}`;
}
export const LEGAL_RUN_PAIRS = new Set(RUN_ROWS.map((x) => pairKey(x.from, x.to)));
export const LEGAL_TASK_PAIRS = new Set(TASK_ROWS.map((x) => pairKey(x.from, x.to)));
const RUN_BY_TRIGGER = new Map(
  RUN_ROWS.map((x) => [`${triggerKey(x.from, x.trigger)}>${x.to}`, x]),
);
const TASK_BY_TRIGGER = new Map(
  TASK_ROWS.map((x) => [`${triggerKey(x.from, x.trigger)}>${x.to}`, x]),
);

export function runRowExists(from: string, trigger: string, to: string): boolean {
  return RUN_BY_TRIGGER.has(`${triggerKey(from, trigger)}>${to}`);
}
export function taskRowExists(from: string, trigger: string, to: string): boolean {
  return TASK_BY_TRIGGER.has(`${triggerKey(from, trigger)}>${to}`);
}

// A paused run's resume_to is the state it left, and is never itself a paused state.
export function resumeTargetAllowed(to: string): boolean {
  return !PAUSED.includes(to as RunStateName);
}
