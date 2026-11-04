import type { FailureClass } from '../contracts/index.ts';

export type FallbackPlan = {
  retry_same: boolean;
  delay_ms: number;
  keep_diff: boolean;
  salvage: boolean;
  backoff_tries: number | null;
  backoff_until: number | null;
  quarantine_until: number | null | 'run';
  quarantine_reason: string | null;
  flag_owner: boolean;
};

const BACKOFF_S = [60, 180, 600];
const empty: FallbackPlan = {
  retry_same: false,
  delay_ms: 0,
  keep_diff: false,
  salvage: false,
  backoff_tries: null,
  backoff_until: null,
  quarantine_until: null,
  quarantine_reason: null,
  flag_owner: false,
};

// Worker fallback policy §3. Pure, given the seen count, the clock and jitter.
export function fallbackPlan(
  cls: FailureClass,
  seenBefore: number,
  now: number,
  jitter: number,
  backoffTries: number,
  statedResetMs: number | null,
): FallbackPlan {
  switch (cls) {
    case 'RATE_LIMIT': {
      const base = BACKOFF_S[Math.min(backoffTries, BACKOFF_S.length - 1)] * 1000;
      const j = 1 + (jitter * 0.4 - 0.2);
      const until =
        statedResetMs !== null && statedResetMs - now <= 15 * 60_000
          ? statedResetMs
          : now + Math.round(base * j);
      return { ...empty, backoff_tries: backoffTries + 1, backoff_until: until };
    }
    case 'QUOTA':
      return {
        ...empty,
        quarantine_until: statedResetMs ?? now + 60 * 60_000,
        quarantine_reason: 'QUOTA',
      };
    case 'OUTAGE':
      if (seenBefore === 0) return { ...empty, retry_same: true, delay_ms: 60_000 };
      return { ...empty, quarantine_until: now + 15 * 60_000, quarantine_reason: 'OUTAGE' };
    case 'TIMEOUT':
      if (seenBefore === 0) return { ...empty, retry_same: true };
      return { ...empty, flag_owner: false };
    case 'MALFORMED':
      if (seenBefore === 0) return { ...empty, retry_same: true, keep_diff: true };
      return empty;
    case 'AUTH':
      return { ...empty, quarantine_until: 'run', quarantine_reason: 'AUTH', flag_owner: true };
    case 'RELAY_LOST':
      if (seenBefore === 0) return { ...empty, retry_same: true, salvage: true };
      return { ...empty, salvage: true };
    case 'UNKNOWN':
      if (seenBefore === 0) return { ...empty, retry_same: true };
      return empty;
    default:
      return empty;
  }
}
