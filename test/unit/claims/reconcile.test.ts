import { describe, expect, it } from 'vitest';
import { reconcileClaims } from '../../../src/claims/reconcile.ts';
import { SimGit } from '../../support/sim.ts';
import { testSpec } from '../../support/harness.ts';

const git = new SimGit({ 'a.txt': '1\n2\n3\n', 'p.json': '{"x":{"y":5}}' });
const spec = testSpec(git.root);
const results: any[] = [
  { id: 'test-unit', status: 'PASS' },
  { id: 'test-bad', status: 'FAIL' },
];
const changed = [{ path: 'a.txt', status: 'M', added: 1, removed: 0 }];
const run = (claims: any[], over: any = {}) =>
  reconcileClaims({
    taskId: 'T1',
    attempt: 1,
    rung: 'r',
    spec,
    requiredTests: ['unit'],
    report: { claims, tests_run_claimed: [] },
    includeWorkerClaims: true,
    git,
    commit: git.root,
    changed,
    results,
    ...over,
  });

describe('claim reconciliation', () => {
  it('generates required claims with no worker claims: one per test, and the changed-file count', async () => {
    const r = await run([]);
    expect(r.ok).toBe(true);
    expect(r.claims.filter((c) => c.required).map((c) => c.type)).toEqual(['TEST_RESULT', 'COUNT']);
  });
  it('a worker filing nothing cannot pass a failed required test', async () => {
    const r = await run([], { requiredTests: ['bad'] });
    expect(r.ok).toBe(false);
  });
  it('verifies a true claim', async () => {
    const r = await run([
      { claim: 'one file', type: 'COUNT', value: 1, verifier: { kind: 'git_diff_stat', spec: {} } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.claims.at(-1)?.final).toBe('VERIFIED');
  });
  it('the 85-versus-84 case: a false count is contradicted, with the true value', async () => {
    const r = await run([
      {
        claim: 'I changed 85 files',
        type: 'COUNT',
        value: 85,
        verifier: { kind: 'git_diff_stat', spec: {} },
      },
    ]);
    expect(r.ok).toBe(false);
    const c = r.claims.at(-1);
    expect(c?.mechanical.status).toBe('CONTRADICTED');
    expect(c?.mechanical.observed).toBe(1);
    expect(c?.final).toBe('REJECTED');
    expect(r.detail).toContain('85');
  });
  it('a number with no usable verifier stays UNVERIFIED, whatever its type', async () => {
    for (const type of ['FACT', 'COUNT', 'BEHAVIOUR']) {
      const r = await run([{ claim: 'it handles 46 cases', type }]);
      expect(r.claims.at(-1)?.final, type).toBe('UNVERIFIED');
      expect(r.ok).toBe(true);
    }
  });
  it('verifier kinds run in code, from the allowlist', async () => {
    const cases: [any, unknown][] = [
      [{ kind: 'file_exists', spec: { path: 'a.txt' } }, true],
      [{ kind: 'file_exists', spec: { path: 'no.txt' } }, false],
      [{ kind: 'line_count', spec: { path: 'a.txt' } }, 3],
      [{ kind: 'file_count', spec: { prefix: '' } }, 2],
      [{ kind: 'json_path', spec: { path: 'p.json', key: 'x.y' } }, 5],
      [{ kind: 'test_id', spec: { id: 'unit' } }, 'pass'],
    ];
    for (const [verifier, value] of cases) {
      const yes = await run([{ claim: 'c', type: 'FACT', value, verifier }]);
      expect(yes.claims.at(-1)?.mechanical.status, verifier.kind).toBe('VERIFIED');
      const no = await run([{ claim: 'c', type: 'FACT', value: 'wrong', verifier }]);
      expect(no.claims.at(-1)?.mechanical.status, verifier.kind).toBe('CONTRADICTED');
    }
  });
  it('a contradicted claim on test results blocks, even though the tests pass', async () => {
    const r = await run([
      {
        claim: 'bad passes',
        type: 'TEST_RESULT',
        value: 'pass',
        verifier: { kind: 'test_id', spec: { id: 'bad' } },
      },
    ]);
    expect(r.ok).toBe(false);
  });
  it('worker claims are ignored at required_only', async () => {
    const r = await run(
      [
        {
          claim: 'I changed 85 files',
          type: 'COUNT',
          value: 85,
          verifier: { kind: 'git_diff_stat', spec: {} },
        },
      ],
      { includeWorkerClaims: false },
    );
    expect(r.ok).toBe(true);
  });
});
