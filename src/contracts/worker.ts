import { z } from 'zod';
import type { FailureClass, UsageRecord } from './common.ts';

export const dispatchRequest = z.strictObject({
  attempt_id: z.string(),
  brief_path: z.string(),
  cwd: z.string(),
  out_dir: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  mode: z.enum(['write', 'read_only']),
  timeout_s: z.number().positive(),
  session_id: z.string().nullable(),
  env_allowlist: z.array(z.string()),
  // Who this call is for. A relay ignores it; the mock uses it to find its script step.
  meta: z
    .strictObject({
      task_id: z.string().nullable(),
      step: z.string(),
      n: z.number().int(),
      rung: z.string(),
      allowed_paths: z.array(z.string()),
      scope: z.strictObject({ acs: z.array(z.string()), files: z.array(z.string()) }),
      point: z.string().optional(),
    })
    .optional(),
});
export type DispatchRequest = z.infer<typeof dispatchRequest>;

export const healthSchema = z.strictObject({
  installed: z.boolean(),
  cli_version: z.string().nullable(),
  version_ok: z.boolean(),
  auth: z.enum(['yes', 'no', 'unknown']),
  quota: z.enum(['ok', 'exhausted', 'unknown']),
  detail: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

export type RawOutcome = {
  relay_status: string | null;
  exit_code: number | null;
  signal: string | null;
  final_message: string;
  stderr_tail: string;
  session_id: string | null;
  model_reported: string | null;
  usage: UsageRecord | null;
  result_present: boolean;
  // Set by the adapter from what it observed; never by worker output.
  transport_provenance: 'mock' | 'fake_cli' | 'real';
  cancelled_by_us: boolean;
  spawn_failed?: boolean;
};

export type DispatchRecord = {
  attempt_id: string;
  out_dir: string;
  cwd: string;
  pid: number | null;
  start_time: string | null;
};

export type RunHandle = {
  attempt_id: string;
  pid: number | null;
  start_time: string | null;
  child_pid?: number | null;
};

// The replaceable boundary (contracts §10).
export interface WorkerAdapter {
  readonly id: string;
  probe(rungId: string): Promise<Health>;
  dispatch(req: DispatchRequest): Promise<RunHandle>;
  wait(h: RunHandle): Promise<RawOutcome>;
  attach(rec: DispatchRecord): Promise<RunHandle | 'gone'>;
  cancel(h: RunHandle): Promise<void>;
  classify(o: RawOutcome): FailureClass;
  usage(o: RawOutcome): UsageRecord;
}

// One way in for anything observing decisions. Defined here so core never imports the shadow module.
export type DecisionRecord = {
  decision_id: string;
  point: string;
  task_id: string | null;
  risk: string;
  subject_tree: string | null;
  action: string;
  target: string | null;
  transition: { from: string; to: string };
  refs: { fingerprints: string[]; signatures: string[] };
  bundle: Record<string, unknown>;
};
export interface DecisionObserver {
  onDecision(rec: DecisionRecord): void;
  // Called when the run ends, so outstanding proposals can settle. It can't change the outcome.
  drain(): Promise<void>;
  // Periodic chance to record finished proposals; has no return value on purpose.
  poll(): void;
  nextWake(): number | null;
}
