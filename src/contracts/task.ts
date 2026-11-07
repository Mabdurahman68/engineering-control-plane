import { z } from 'zod';
import { glob, nonEmpty, risk } from './common.ts';

export const LANES = [
  'research',
  'implementation',
  'hard-code',
  'tests',
  'integration-repair',
] as const;
export const lane = z.enum(LANES);

export const taskSchema = z.strictObject({
  schema: z.literal('task.v1'),
  task_id: z.string().regex(/^[A-Za-z0-9-]+$/),
  spec_id: nonEmpty,
  goal: nonEmpty,
  lane,
  allowed_paths: z.array(glob).min(1),
  forbidden_paths: z.array(glob),
  acceptance_criteria: z.array(z.string()),
  required_tests: z.array(z.string()),
  depends_on: z.array(z.string()),
  risk,
});
export type Task = z.infer<typeof taskSchema>;
