import type { ReviewFinding, ReviewReport } from '../contracts/index.ts';
import { SEMANTIC_CHECKS } from '../contracts/index.ts';

const blocking = (f: ReviewFinding | undefined) =>
  f?.severity === 'blocker' || f?.severity === 'major';

export type ConsistencyContext = {
  scopeAcs: string[];
  // human_reserved, or an in-force owner mark_human_verified. From the spec and ledger, never the model.
  coveredAcs: string[];
  changedFiles: string[];
  requireFileCoverage: boolean;
};

// Contracts §5, with the one recorded extension for uncovered UNVERIFIABLE criteria.
export function consistencyErrors(r: ReviewReport, ctx: ConsistencyContext): string[] {
  const e: string[] = [];
  const f = r.findings;
  const anyBlocking = f.some(blocking);
  const refsExist = (refs: number[], where: string) => {
    for (const x of refs) if (!f[x]) e.push(`${where}: finding_ref ${x} doesn't exist`);
  };

  const seen = new Map<string, number>();
  for (const c of r.criteria) seen.set(c.ac, (seen.get(c.ac) ?? 0) + 1);
  for (const ac of ctx.scopeAcs) {
    if ((seen.get(ac) ?? 0) !== 1) e.push(`criterion ${ac} must appear exactly once`);
  }
  for (const ac of seen.keys())
    if (!ctx.scopeAcs.includes(ac)) e.push(`criterion ${ac} isn't in scope`);

  const cited = new Set<number>();
  let failedAny = false;
  let uncoveredUnverifiable = false;
  for (const c of r.criteria) {
    refsExist(c.finding_refs, `criterion ${c.ac}`);
    if (c.verdict === 'FAIL') {
      failedAny = true;
      if (!c.finding_refs.some((x) => blocking(f[x]))) {
        e.push(`failed criterion ${c.ac} cites no blocker or major finding`);
      }
      c.finding_refs.forEach((x) => cited.add(x));
    }
    if (c.verdict === 'UNVERIFIABLE' && !ctx.coveredAcs.includes(c.ac)) {
      uncoveredUnverifiable = true;
      if (!c.finding_refs.some((x) => blocking(f[x]))) {
        e.push(`uncovered UNVERIFIABLE ${c.ac} cites no blocker or major finding`);
      }
      c.finding_refs.forEach((x) => cited.add(x));
    }
  }
  for (const name of SEMANTIC_CHECKS) {
    const s = r.semantic_checks[name];
    refsExist(s.finding_refs, `semantic ${name}`);
    if (s.verdict === 'FAIL') {
      failedAny = true;
      if (!s.finding_refs.some((x) => blocking(f[x]))) {
        e.push(`failed semantic ${name} cites no blocker or major finding`);
      }
      s.finding_refs.forEach((x) => cited.add(x));
    }
  }
  if (r.verdict === 'PASS') {
    if (anyBlocking) e.push('PASS with a blocker or major finding');
    if (failedAny) e.push('PASS with a failed criterion or semantic check');
    if (uncoveredUnverifiable) e.push('PASS with an uncovered UNVERIFIABLE criterion');
  } else if (!anyBlocking) {
    e.push('FAIL with no blocker or major finding');
  }
  f.forEach((x, i) => {
    if (blocking(x) && !cited.has(i))
      e.push(`finding ${i} is blocking, and nothing failed cites it`);
  });
  if (ctx.requireFileCoverage) {
    for (const p of ctx.changedFiles) {
      if (!r.looked_at.files.includes(p)) e.push(`looked_at.files omits ${p}`);
    }
  }
  return e;
}
