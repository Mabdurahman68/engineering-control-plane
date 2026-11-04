import type { Claim, Spec, WorkerReport } from '../contracts/index.ts';
import type { GateResult } from '../gates/gates.ts';
import type { ChangedFile, GitPort } from '../worktree/port.ts';

const HAS_NUMBER = /\d/;

async function verifyWith(
  claim: {
    type: string;
    value?: unknown;
    verifier?: { kind: string; spec: Record<string, unknown> };
  },
  ctx: { git: GitPort; commit: string; changed: ChangedFile[]; results: GateResult[] },
): Promise<{ applicable: boolean; observed: unknown }> {
  const v = claim.verifier;
  if (!v || v.kind === 'none') return { applicable: false, observed: null };
  const s = v.spec;
  switch (v.kind) {
    case 'git_diff_stat':
      return { applicable: true, observed: ctx.changed.length };
    case 'file_exists':
      return {
        applicable: true,
        observed: (await ctx.git.readFile(ctx.commit, String(s.path))) !== null,
      };
    case 'file_count': {
      const prefix = String(s.prefix ?? '');
      const files = await ctx.git.listTracked(ctx.commit);
      return { applicable: true, observed: files.filter((f) => f.startsWith(prefix)).length };
    }
    case 'line_count': {
      const text = await ctx.git.readFile(ctx.commit, String(s.path));
      return {
        applicable: text !== null,
        observed:
          text === null
            ? null
            : text.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length,
      };
    }
    case 'json_path': {
      const text = await ctx.git.readFile(ctx.commit, String(s.path));
      if (text === null) return { applicable: false, observed: null };
      try {
        let cur: any = JSON.parse(text);
        for (const k of String(s.key).split('.')) cur = cur?.[k];
        return { applicable: true, observed: cur ?? null };
      } catch {
        return { applicable: false, observed: null };
      }
    }
    case 'test_id': {
      const r = ctx.results.find((x) => x.id === `test-${String(s.id)}`);
      return {
        applicable: r !== undefined,
        observed: r ? (r.status === 'PASS' ? 'pass' : 'fail') : null,
      };
    }
    default:
      return { applicable: false, observed: null };
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b);

// Contracts §4. Code computes; a model's claim about its own work is only a claim.
export async function reconcileClaims(input: {
  taskId: string;
  attempt: number;
  rung: string;
  spec: Spec;
  requiredTests: string[];
  report: Pick<WorkerReport, 'claims' | 'tests_run_claimed'> | null;
  includeWorkerClaims: boolean;
  git: GitPort;
  commit: string;
  changed: ChangedFile[];
  results: GateResult[];
}): Promise<{ claims: Claim[]; ok: boolean; detail: string }> {
  const out: Claim[] = [];
  let n = 0;
  const id = () => `C-${input.taskId}-${input.attempt}-${++n}`;
  const base = (over: Partial<Claim>): Claim => ({
    schema: 'claim.v1',
    claim_id: id(),
    task_id: input.taskId,
    claim: '',
    type: 'FACT',
    value: null,
    asserted_by: 'code',
    required: false,
    verifier: { kind: 'none', spec: {} },
    mechanical: { status: 'NOT_APPLICABLE', observed: null, evidence: null },
    independent_review: {
      status: 'NOT_REVIEWED',
      reviewer: null,
      reason: null,
      corrected_value: null,
    },
    final: 'UNVERIFIED',
    ...over,
  });
  for (const t of input.requiredTests) {
    const r = input.results.find((x) => x.id === `test-${t}`);
    const passed = r?.status === 'PASS';
    out.push(
      base({
        claim: `required test ${t} passes`,
        type: 'TEST_RESULT',
        value: 'pass',
        required: true,
        verifier: { kind: 'test_id', spec: { id: t } },
        mechanical: {
          status: passed ? 'VERIFIED' : 'CONTRADICTED',
          observed: r ? (passed ? 'pass' : 'fail') : 'not run',
          evidence: null,
        },
        final: passed ? 'VERIFIED' : 'REJECTED',
      }),
    );
  }
  out.push(
    base({
      claim: 'changed-file count',
      type: 'COUNT',
      value: input.changed.length,
      required: true,
      verifier: { kind: 'git_diff_stat', spec: {} },
      mechanical: { status: 'VERIFIED', observed: input.changed.length, evidence: null },
      final: 'VERIFIED',
    }),
  );
  if (input.includeWorkerClaims && input.report) {
    for (const c of input.report.claims) {
      const v = await verifyWith(c, {
        git: input.git,
        commit: input.commit,
        changed: input.changed,
        results: input.results,
      });
      const mechanicalType =
        c.type === 'COUNT' || c.type === 'TEST_RESULT' || c.type === 'FILE_EXISTS';
      const rec = base({
        claim: c.claim,
        type: c.type,
        value: c.value ?? null,
        asserted_by: input.rung,
        verifier: c.verifier ?? { kind: 'none', spec: {} },
      });
      if (v.applicable) {
        const agrees = same(c.value, v.observed);
        rec.mechanical = {
          status: agrees ? 'VERIFIED' : 'CONTRADICTED',
          observed: v.observed,
          evidence: null,
        };
        rec.final = agrees ? 'VERIFIED' : 'REJECTED';
      } else if (mechanicalType || HAS_NUMBER.test(c.claim) || typeof c.value === 'number') {
        // A number with no usable verifier stays UNVERIFIED, whatever its type. No model can mark it.
        rec.final = 'UNVERIFIED';
      }
      out.push(rec);
    }
    for (const claimed of input.report.tests_run_claimed) {
      if (!input.spec.required_tests.some((t) => t.id === claimed)) continue;
      const r = input.results.find((x) => x.id === `test-${claimed}`);
      if (!r) continue;
      const passed = r.status === 'PASS';
      out.push(
        base({
          claim: `worker ran ${claimed} and it passed`,
          type: 'TEST_RESULT',
          value: 'pass',
          asserted_by: input.rung,
          verifier: { kind: 'test_id', spec: { id: claimed } },
          mechanical: {
            status: passed ? 'VERIFIED' : 'CONTRADICTED',
            observed: passed ? 'pass' : 'fail',
            evidence: null,
          },
          final: passed ? 'VERIFIED' : 'REJECTED',
        }),
      );
    }
  }
  const unverifiedRequired = out.filter((c) => c.required && c.final !== 'VERIFIED');
  const contradicted = out.filter((c) => c.mechanical.status === 'CONTRADICTED');
  const ok = unverifiedRequired.length === 0 && contradicted.length === 0;
  const detail = ok
    ? 'claims reconcile'
    : [...new Set([...unverifiedRequired, ...contradicted])]
        .map((c) => `${c.claim}: observed ${JSON.stringify(c.mechanical.observed)}`)
        .join('; ');
  return { claims: out, ok, detail };
}
