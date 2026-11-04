import type { Review, ReviewReport, Waiver } from '../contracts/index.ts';
import { SEMANTIC_CHECKS } from '../contracts/index.ts';

export type FindingWaiver = Pick<Waiver, 'resolves'>;

// Pure. A consistent FAIL becomes PASS only if every blocker or major finding, failed criterion and
// failed semantic check is resolved by a waiver bound to it specifically (state machine §4.6).
export function effectiveVerdict(
  review: Pick<Review, 'verdict' | 'criteria' | 'semantic_checks' | 'findings'>,
  waivers: FindingWaiver[],
  coveredAcs: string[],
): { verdict: 'PASS' | 'FAIL'; unresolved: string[] } {
  if (review.verdict === 'PASS') return { verdict: 'PASS', unresolved: [] };
  const unresolved: string[] = [];
  const blockingIdx = new Set(
    review.findings.flatMap((f, i) =>
      f.severity === 'blocker' || f.severity === 'major' ? [i] : [],
    ),
  );
  const fp = (i: number) => review.findings[i]?.fingerprint;
  const waivedFinding = (i: number) =>
    waivers.some((w) => w.resolves.finding_fingerprint === fp(i));
  for (const i of blockingIdx) if (!waivedFinding(i)) unresolved.push(`finding:${fp(i)}`);
  for (const c of review.criteria) {
    if (c.verdict === 'UNVERIFIABLE' && !coveredAcs.includes(c.ac)) {
      // Only an owner's mark_human_verified covers this. A waiver on the finding doesn't.
      unresolved.push(`unverifiable:${c.ac}`);
    }
    if (c.verdict !== 'FAIL') continue;
    const refs = c.finding_refs.filter((i) => blockingIdx.has(i));
    const bound = refs.every((i) =>
      waivers.some(
        (w) => w.resolves.finding_fingerprint === fp(i) && w.resolves.criterion === c.ac,
      ),
    );
    if (!bound || refs.length === 0) unresolved.push(`criterion:${c.ac}`);
  }
  for (const name of SEMANTIC_CHECKS) {
    const s = review.semantic_checks[name];
    if (s.verdict !== 'FAIL') continue;
    const refs = s.finding_refs.filter((i) => blockingIdx.has(i));
    const bound = refs.every((i) =>
      waivers.some(
        (w) => w.resolves.finding_fingerprint === fp(i) && w.resolves.semantic_check === name,
      ),
    );
    if (!bound || refs.length === 0) unresolved.push(`semantic:${name}`);
  }
  return { verdict: unresolved.length ? 'FAIL' : 'PASS', unresolved };
}

// Why a blocking finding wasn't covered, when a waiver covered its subject: reported apart from new
// findings, so the cost of the conservative identity rule can be measured.
export function waiverVoidCause(
  fingerprint: string,
  waivers: FindingWaiver[],
): 'anchor_changed' | 'text_changed' | null {
  const parts = (x: string) => {
    const d = x.lastIndexOf('|');
    const a = x.lastIndexOf('|', d - 1);
    return { key: x.slice(0, a), anchor: x.slice(a + 1, d), digest: x.slice(d + 1) };
  };
  const me = parts(fingerprint);
  for (const w of waivers) {
    const other = w.resolves.finding_fingerprint;
    if (!other || other === fingerprint) continue;
    const o = parts(other);
    if (o.key !== me.key) continue;
    if (o.digest !== me.digest) return 'text_changed';
    if (o.anchor !== me.anchor) return 'anchor_changed';
  }
  return null;
}

export function reportHasOnlyUnverifiableFailures(r: ReviewReport, coveredAcs: string[]): boolean {
  const uncovered = r.criteria.filter(
    (c) => c.verdict === 'UNVERIFIABLE' && !coveredAcs.includes(c.ac),
  );
  if (uncovered.length === 0) return false;
  if (r.criteria.some((c) => c.verdict === 'FAIL')) return false;
  if (SEMANTIC_CHECKS.some((n) => r.semantic_checks[n].verdict === 'FAIL')) return false;
  const linked = new Set(uncovered.flatMap((c) => c.finding_refs));
  return r.findings.every(
    (f, i) => !(f.severity === 'blocker' || f.severity === 'major') || linked.has(i),
  );
}
