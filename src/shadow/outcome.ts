import type { LedgerEvent, ShadowProposal, ShadowReport } from '../contracts/index.ts';
import { matchPrediction, type PredictionResult } from './predictions.ts';

type Observed = ShadowProposal['outcome']['observed'];
type OwnerPref = ShadowProposal['outcome']['owner_preference'];

// The observed-outcome rules. Code only; anything else is UNDETERMINED. Owner decisions aren't inputs.
export function observedOutcome(
  coordinatorAction: string,
  report: ShadowReport,
  legal: boolean,
  taskId: string | null,
  after: LedgerEvent[],
): Observed {
  const predictions: PredictionResult[] = report.predicted_defects.map((p, i) =>
    matchPrediction(p, i, after, taskId),
  );
  const horizon_reached = predictions.every((p) => p.status !== 'horizon_not_reached');
  const out = (label: Observed['label'], rule: string | null): Observed => ({
    predictions,
    horizon_reached,
    label,
    rule,
  });
  if (!legal) return out('CONSISTENT_WITH_COORDINATOR', 'illegal_proposal');
  const repairing = coordinatorAction === 'repair' || coordinatorAction === 'repair_next_rung';
  if (repairing && report.action === 'escalate') {
    const end = after.find(
      (e) =>
        (taskId === null || e.task_id === taskId) &&
        e.type === 'task.state_changed' &&
        (e.data.escalation_reason === 'REPAIR_EXHAUSTED' || e.data.to === 'TASK_PASSED'),
    );
    if (end?.data.escalation_reason === 'REPAIR_EXHAUSTED')
      return out('CONSISTENT_WITH_SHADOW', 'repair_vs_escalate_exhausted');
    if (end?.data.to === 'TASK_PASSED')
      return out('CONSISTENT_WITH_COORDINATOR', 'repair_vs_escalate_passed');
    return out('UNDETERMINED', null);
  }
  const proceeding =
    coordinatorAction === 'proceed_to_review' || coordinatorAction === 'accept_task';
  if (proceeding && report.action === 'repair' && predictions.length > 0) {
    if (predictions.some((p) => p.status === 'exact_match'))
      return out('CONSISTENT_WITH_SHADOW', 'repair_vs_proceed_with_prediction');
    if (predictions.every((p) => p.status === 'not_observed'))
      return out('CONSISTENT_WITH_COORDINATOR', 'repair_vs_proceed_not_observed_provisional');
  }
  // Fallback choices such as next_rung versus wait stay undetermined, and so do escalations here.
  return out('UNDETERMINED', null);
}

const OPTION_ACTION: Record<string, string> = {
  retry_task: 'retry_same_rung',
  retry_integration: 'repair',
  abandon: 'abandon',
  waive: 'waive',
  override: 'override',
  reject: 'repair',
  approve: 'mark_ready',
};

// What the owner chose. Preference, and never evidence of correctness.
export function ownerPreference(
  coordinatorAction: string,
  shadowAction: string,
  decision: Record<string, any> | null,
): OwnerPref {
  if (!decision)
    return {
      decision_id: null,
      option_id: null,
      aligned_with: null,
      new_information: null,
      authority_exercised: null,
    };
  const chosen = OPTION_ACTION[decision.option_id] ?? decision.option_id;
  const aligned_with =
    chosen === shadowAction ? 'shadow' : chosen === coordinatorAction ? 'coordinator' : 'neither';
  return {
    decision_id: decision.escalation_id,
    option_id: decision.option_id,
    aligned_with,
    new_information: decision.new_information ?? null,
    authority_exercised: decision.authority_exercised ?? null,
  };
}
