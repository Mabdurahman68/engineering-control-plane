export type AttemptHistory = {
  tree: string | null;
  signature: string | null;
  stall_keys: string[];
};

// Depth policy §7. Pure; only reads what the ledger recorded for each attempt.
export function stallSignal(h: AttemptHistory[]): string | null {
  const n = h.length;
  if (n < 2) return null;
  const last = h[n - 1];
  const prev = h[n - 2];
  if (last.tree && last.tree === prev.tree) return 'no_change';
  if (last.tree && h.slice(0, n - 1).some((x) => x.tree === last.tree)) return 'oscillation';
  if (last.signature && last.signature === prev.signature) return 'same_failure';
  if (n >= 3) {
    const before = h[n - 3];
    if (last.stall_keys.some((k) => prev.stall_keys.includes(k) && before.stall_keys.includes(k))) {
      return 'same_finding';
    }
  }
  return null;
}
