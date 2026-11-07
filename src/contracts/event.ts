import { z } from 'zod';
import { hex64, isoTime } from './common.ts';

export const EVENT_TYPES = [
  // Run
  'run.created',
  'run.state_changed',
  'run.lock_acquired',
  'run.resumed',
  'heartbeat',
  'host.sleep_detected',
  'ledger.torn_tail_recovered',
  'invariant.violation',
  'risk.raised',
  'operator.decision',
  // Plan
  'plan.intent',
  'plan.accepted',
  'plan.rejected',
  // Reservation
  'reservation.released',
  'dispatch.orphans_swept',
  'attempt.result_fenced',
  // Evidence identity
  'tree.identity_checked',
  'evidence.discarded_stale',
  // Publish
  'push.sha_frozen',
  'push.gate_started',
  'push.gate_failed',
  'push.intent',
  'push.done',
  'push.verified',
  'push.rejected',
  'pr.intent',
  'pr.opened',
  'pr.validated',
  'pr.validation_failed',
  'publish.base_accepted',
  // Task
  'task.state_changed',
  'worktree.created',
  'worktree.salvaged',
  'snapshot.recorded',
  'commit.intent',
  'commit.done',
  // Dispatch
  'eligibility.checked',
  'dispatch.intent',
  'dispatch.started',
  'dispatch.child_recorded',
  'dispatch.finished',
  'dispatch.classified',
  'fallback.taken',
  'backoff.started',
  'worker.quarantined',
  'cancel.sent',
  // Evidence
  'gate.intent',
  'gate.finished',
  'claim.recorded',
  'claim.reconciled',
  // Review
  'review.intent',
  'review.collected',
  'review.invalid',
  'repair.requested',
  'stall.detected',
  // Disagreement
  'disagreement.opened',
  'disagreement.adjudicated',
  'challenge.requested',
  'waiver.recorded',
  // Integration
  'merge.intent',
  'merge.done',
  'merge.conflict',
  'merge.aborted',
  // Budget
  'usage.recorded',
  'cap.warning',
  'cap.reached',
  // Shadow
  'decision.made',
  'shadow.intent',
  'shadow.recorded',
  'shadow.unavailable',
  'shadow.outcome_resolved',
  // Output
  'report.written',
  'notification.sent',
  'notification.failed',
  'escalation.raised',
  'operator.request_received',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const eventSchema = z.strictObject({
  schema: z.literal('event.v1'),
  seq: z.number().int().nonnegative(),
  at: isoTime,
  run_id: z.string(),
  task_id: z.string().nullable(),
  type: z.enum(EVENT_TYPES),
  data: z.record(z.string(), z.unknown()),
  prev: z.string(),
  hash: hex64,
});
export type LedgerEvent = z.infer<typeof eventSchema>;
