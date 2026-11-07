import type { ShadowAction, ShadowReport } from '../contracts/index.ts';
import { RUN_ROWS, TASK_ROWS } from '../core/tables.ts';

// Where each action would go. Legality asks the tables whether that move exists from this state.
const TARGETS: Partial<Record<ShadowAction, string[]>> = {
  proceed_to_review: ['REVIEWING'],
  accept_task: ['TASK_PASSED'],
  repair: ['REPAIR_PENDING', 'DISPATCHING'],
  repair_next_rung: ['DISPATCHING'],
  retry_same_rung: ['DISPATCHING'],
  next_rung: ['DISPATCHING'],
  wait: ['TASK_WAITING_WORKER', 'PAUSED_NO_WORKER'],
  pause: ['TASK_WAITING_WORKER', 'PAUSED_OPERATOR', 'PAUSED_NO_WORKER'],
  request_challenge: ['CHALLENGE_PENDING'],
  adjudicate: ['TASK_DISAGREEMENT'],
  waive: ['GATING', 'TASK_PASSED'],
  override: ['REVIEWING', 'TASK_PASSED'],
  replan: ['PLANNING'],
  integrate: ['EXECUTING', 'INTEGRATING', 'VERIFYING'],
  reverify: ['VERIFYING', 'INTEGRATING'],
  mark_ready: ['READY_FOR_HUMAN_MERGE', 'MOCK_RUN_COMPLETE'],
  push: ['PR_OPENED', 'PUSHING'],
  hold_push: ['PUSH_BLOCKED'],
  escalate: ['TASK_ESCALATED', 'ESCALATION_REQUIRED'],
  abandon: ['CANCELLED', 'TASK_CANCELLED'],
};

const HARD_GATE = /^H-/;

export type Comparison = {
  match: boolean;
  match_rule: 'action_and_target' | 'action_only';
  proposal_legal: boolean;
  would_violate: string[];
};

export type Coordinator = {
  action: string;
  target: string | null;
  transition: { from: string; to: string };
  refs: { fingerprints: string[]; signatures: string[] };
};

export function compareProposal(
  report: ShadowReport,
  c: Coordinator,
  context: { failedHardGates: string[]; reviewed: boolean },
): Comparison {
  const bothTargets = report.target !== null && c.target !== null;
  const match =
    report.action !== 'other' &&
    report.action === c.action &&
    (!bothTargets || report.target === c.target);
  const would_violate: string[] = [];
  const targets = TARGETS[report.action] ?? [];
  const rows = [...RUN_ROWS, ...TASK_ROWS];
  const legalMove =
    report.action === 'other'
      ? false
      : targets.some((to) => rows.some((r) => r.from === c.transition.from && r.to === to));
  if (!legalMove && report.action !== 'other')
    would_violate.push(`no row from ${c.transition.from}`);
  if (
    ['waive', 'override', 'accept_task', 'proceed_to_review', 'mark_ready', 'push'].includes(
      report.action,
    )
  ) {
    for (const g of context.failedHardGates) if (HARD_GATE.test(g)) would_violate.push(g);
  }
  if (report.action === 'accept_task' && !context.reviewed) would_violate.push('H-REVIEW');
  if (report.action === 'mark_ready' && !context.reviewed) would_violate.push('H-REVIEW');
  return {
    match,
    match_rule: bothTargets ? 'action_and_target' : 'action_only',
    proposal_legal: would_violate.length === 0 && report.action !== 'other',
    would_violate,
  };
}
