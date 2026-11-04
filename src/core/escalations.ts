import type { EscalationReason } from '../contracts/index.ts';

type Option = { id: string; text: string; consequence: string };
const ABANDON: Option = {
  id: 'abandon',
  text: 'Abandon the run',
  consequence: 'The run ends as CANCELLED',
};

// State machine §5. A waive option on a hard gate doesn't exist.
export function optionsFor(
  reason: EscalationReason,
  taskId: string | null,
  opts: { synthetic?: boolean } = {},
): Option[] {
  const retry: Option =
    taskId !== null && !taskId.startsWith('T-INT')
      ? {
          id: 'retry_task',
          text: 'Retry the task from its base',
          consequence: 'Counters reset; your note goes in the brief',
        }
      : {
          id: 'retry_integration',
          text: 'Retry integration',
          consequence: 'A new T-INT task from the last integration tip',
        };
  switch (reason) {
    case 'SPEC_DEFECT':
    case 'PLAN_INVALID':
      return [ABANDON];
    case 'HARD_GATE_BREACH':
    case 'REPAIR_EXHAUSTED':
      return [retry, ABANDON];
    case 'MERGE_CONFLICT':
      if (opts.synthetic) return [ABANDON];
      return [
        {
          id: 'retry_integration',
          text: 'Retry integration with guidance',
          consequence: 'A new T-INT task',
        },
        ABANDON,
      ];
    case 'UNRESOLVED_DISAGREEMENT':
      return [
        {
          id: 'waive',
          text: 'Waive the soft gate',
          consequence: 'Recorded with adjudicator: human',
        },
        {
          id: 'override',
          text: 'Override the finding',
          consequence: 'Recorded with adjudicator: human',
        },
        {
          id: 'reject',
          text: 'Reject the challenge or dispute',
          consequence: 'The task goes to repair',
        },
        ABANDON,
      ];
    case 'UNVERIFIABLE_CRITERION':
      return [
        {
          id: 'mark_human_verified',
          text: 'State you verified it yourself',
          consequence: 'Verification restarts; the report says you verified it, not the system',
        },
        ABANDON,
      ];
    case 'HUMAN_IRREVERSIBLE_GATE':
      return [
        {
          id: 'approve',
          text: 'Approve',
          consequence: 'READY_FOR_HUMAN_MERGE, with your approval in the report',
        },
        { id: 'reject', text: 'Reject', consequence: 'The run ends as CANCELLED' },
        ABANDON,
      ];
  }
}
