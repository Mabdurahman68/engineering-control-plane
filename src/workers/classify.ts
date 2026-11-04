import type { FailureClass, FailureClasses, RawOutcome } from '../contracts/index.ts';

const ORDER: FailureClass[] = ['AUTH', 'QUOTA', 'RATE_LIMIT', 'OUTAGE'];

// Priority per integration §5: known class patterns, then transport status. Unmatched is UNKNOWN,
// which is never treated as success.
export function classifyOutcome(
  raw: RawOutcome,
  table: FailureClasses,
  adapter: string,
): FailureClass {
  if (raw.spawn_failed) return 'UNKNOWN';
  if (!raw.result_present) return 'RELAY_LOST';
  if (raw.relay_status === 'timeout') return 'TIMEOUT';
  if (raw.relay_status === 'aborted') return raw.cancelled_by_us ? 'CANCELLED' : 'RELAY_LOST';
  if (raw.relay_status === 'completed' && raw.exit_code === 0) return 'OK';
  const rows = [...(table.adapters[adapter] ?? []), ...(table.adapters.default ?? [])];
  const text = raw.stderr_tail;
  for (const cls of ORDER) {
    for (const row of rows) {
      if (row.class !== cls) continue;
      if (row.exit_code !== undefined && raw.exit_code === row.exit_code) return cls;
      if (row.pattern && new RegExp(row.pattern, 'i').test(text)) return cls;
    }
  }
  return 'UNKNOWN';
}
