import { z } from 'zod';

export const hex40 = z.string().regex(/^[0-9a-f]{40}$/);
export const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const isoTime = z.iso.datetime();
export const glob = z.string().min(1);
export const nonEmpty = z.string().trim().min(1);
export const RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const risk = z.enum(RISKS);
export type Risk = z.infer<typeof risk>;
export const DEPTHS = ['QUICK', 'STANDARD', 'DEEP', 'EXHAUSTIVE'] as const;
export const depth = z.enum(DEPTHS);
export type Depth = z.infer<typeof depth>;
export const argv = z.array(z.string()).min(1);
export const commandSpec = z.strictObject({
  command: argv,
  timeout_s: z.number().int().positive(),
});
export type CommandSpec = z.infer<typeof commandSpec>;
export const artifactRef = z.strictObject({ path: z.string(), sha256: hex64 });
export type ArtifactRef = z.infer<typeof artifactRef>;
export const excerptRef = z.strictObject({ path: z.string(), excerpt: z.string() });
export const FAILURE_CLASSES = [
  'OK',
  'MALFORMED',
  'RATE_LIMIT',
  'QUOTA',
  'AUTH',
  'OUTAGE',
  'TIMEOUT',
  'CANCELLED',
  'RELAY_LOST',
  'UNKNOWN',
] as const;
export const failureClass = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof failureClass>;
export const usageRecord = z.strictObject({
  source: z.enum(['vendor_cli_event', 'vendor_cli_result', 'unavailable']),
  tokens: z.union([
    z.strictObject({ input: z.number(), output: z.number(), cached: z.number() }),
    z.literal('unavailable'),
  ]),
  cost_usd: z.union([z.number(), z.literal('unavailable')]),
  quota_snapshot: z.union([z.record(z.string(), z.unknown()), z.literal('unavailable')]),
  wall_clock_s: z.number(),
});
export type UsageRecord = z.infer<typeof usageRecord>;
