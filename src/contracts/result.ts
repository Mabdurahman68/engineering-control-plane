import { z } from 'zod';
import { artifactRef, failureClass, hex40, isoTime, usageRecord } from './common.ts';
import { disputedFinding, workerClaim } from './agent.ts';

export const resultSchema = z.strictObject({
  schema: z.literal('result.v1'),
  task_id: z.string(),
  attempt: z.number().int(),
  step: z.enum(['work', 'repair']),
  worker: z.strictObject({
    rung_id: z.string(),
    adapter: z.string(),
    cli_version: z.string().nullable(),
    model_requested: z.string(),
    model_reported: z.string().nullable(),
    family: z.string(),
  }),
  session_id: z.string().nullable(),
  class: failureClass,
  exit: z.strictObject({
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    relay_status: z.string().nullable(),
  }),
  changed_files: z.array(
    z.strictObject({
      path: z.string(),
      status: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
    }),
  ),
  tree_hash: hex40.nullable(),
  tests_run_claimed: z.array(z.string()),
  known_issues: z.array(z.string()),
  claims: z.array(workerClaim),
  disputed_findings: z.array(disputedFinding),
  usage: usageRecord,
  artifacts: z.strictObject({
    brief: artifactRef.nullable(),
    events: artifactRef.nullable(),
    final: artifactRef.nullable(),
    stderr: artifactRef.nullable(),
    relay_result: artifactRef.nullable(),
  }),
  started_at: isoTime,
  finished_at: isoTime,
});
export type Result = z.infer<typeof resultSchema>;
