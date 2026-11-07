import { z } from 'zod';
import { depth, risk, usageRecord } from './common.ts';

export const RUN_STATES = [
  'CREATED',
  'PREFLIGHT',
  'PLANNING',
  'EXECUTING',
  'INTEGRATING',
  'VERIFYING',
  'PAUSED_NO_WORKER',
  'PAUSED_BUDGET',
  'PAUSED_OPERATOR',
  'ESCALATION_REQUIRED',
  'READY_FOR_HUMAN_MERGE',
  'PUSHING',
  'PR_OPENED',
  'PUSH_BLOCKED',
  'FAILED',
  'CANCELLED',
  'MOCK_RUN_COMPLETE',
] as const;
export type RunStateName = (typeof RUN_STATES)[number];

export const TASK_STATES = [
  'PENDING',
  'READY',
  'DISPATCHING',
  'WORKING',
  'COLLECTING',
  'GATING',
  'CHALLENGE_PENDING',
  'REVIEWING',
  'REPAIR_PENDING',
  'TASK_DISAGREEMENT',
  'TASK_WAITING_WORKER',
  'TASK_PASSED',
  'TASK_BLOCKED',
  'TASK_ESCALATED',
  'TASK_CANCELLED',
] as const;
export type TaskStateName = (typeof TASK_STATES)[number];

export const NEXT_STEPS = ['work', 'repair', 'gate', 'review', 'challenge', 'adjudicate'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

// run.json: a projection rebuilt from the ledger, never read as truth.
export const runStateSchema = z.strictObject({
  schema: z.literal('run_state.v1'),
  run_id: z.string(),
  spec_id: z.string(),
  spec_sha: z.string(),
  policy_sha: z.string(),
  state: z.enum(RUN_STATES),
  resume_to: z.enum(RUN_STATES).nullable(),
  reason: z.string().nullable(),
  effective: z.strictObject({ risk, depth }),
  tasks: z.record(
    z.string(),
    z.strictObject({
      state: z.enum(TASK_STATES),
      attempt: z.number().int(),
      rung_id: z.string().nullable(),
      authors: z.array(z.string()),
      tree_hash: z.string().nullable(),
      commit: z.string().nullable(),
    }),
  ),
  integration: z.strictObject({
    branch: z.string().nullable(),
    tip: z.string().nullable(),
    merged: z.array(z.string()),
  }),
  counters: z.strictObject({
    invocations: z.number().int(),
    repairs: z.number().int(),
    fallbacks: z.number().int(),
    wall_clock_s: z.number(),
  }),
  usage: z.strictObject({
    tokens: z.union([z.number(), z.literal('unavailable')]),
    cost_usd: z.union([z.number(), z.literal('unavailable')]),
    measured_coverage: z.string(),
  }),
  last_event: z
    .strictObject({ seq: z.number().int(), type: z.string(), at: z.string() })
    .nullable(),
  shadow: z.strictObject({
    decision_points: z.number().int(),
    recorded: z.number().int(),
    matched: z.number().int(),
    unavailable: z.number().int(),
    skipped: z.number().int(),
    invocations: z.number().int(),
  }),
  blockers: z.array(z.string()),
});
export type RunStateProjection = z.infer<typeof runStateSchema>;
export { usageRecord };
