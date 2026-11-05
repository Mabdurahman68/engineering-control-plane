import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Spec } from '../../../src/contracts/index.ts';
import {
  checkAc,
  checkCap,
  checkClean,
  checkEvidence,
  checkGitCfg,
  checkLedger,
  checkNoCommit,
  checkNoPush,
  checkRepo,
  checkReview,
  checkReviewReadOnly,
  checkSpecLock,
  checkTreeId,
} from '../../../src/gates/checks.ts';
import { type GateInput, runGates } from '../../../src/gates/gates.ts';
import { globMatch } from '../../../src/gates/glob.ts';
import { RealCommandRunner } from '../../../src/gates/runner.ts';
import { compileSecretPatterns } from '../../../src/gates/secret.ts';
import { gateSignature } from '../../../src/gates/signature.ts';
import { Ledger, loadLedger, MemLedgerStore } from '../../../src/ledger/ledger.ts';
import { loadPolicy } from '../../../src/policy/load.ts';
import { MemRunStore } from '../../../src/worktree/fs-store.ts';
import { RealGit } from '../../../src/worktree/real-git.ts';
import { makeRepo, sh, tempDir, writeTree } from '../../support/repo.ts';

const NODE = process.execPath;
const passCmd = { command: [NODE, '-e', 'process.exit(0)'], timeout_s: 30 };
const failCmd = {
  command: [NODE, '-e', 'console.error("Error: boom");process.exit(1)'],
  timeout_s: 30,
};

function makeSpec(over: Partial<Spec> = {}): Spec {
  return {
    schema: 'spec.v1',
    spec_id: 'S',
    title: 't',
    goal: 'g',
    target: { repo_path: 'x', base_commit: 'a'.repeat(40), repo_identity: 'a'.repeat(40) },
    requested_depth: 'QUICK',
    declared_risk: 'low',
    data_classes: [],
    product_behaviour: '',
    non_goals: [],
    architecture_decisions: [],
    affected_surfaces: [],
    invariants: [],
    acceptance_criteria: [
      {
        id: 'AC-1',
        text: 't',
        human_reserved: false,
        verify: [{ kind: 'semantic', question: 'q' }],
      },
    ],
    required_tests: [],
    full_test_command: passCmd,
    expect_red_baseline: false,
    gate_commands: {},
    known_control_files: [],
    allowed_control_paths: [],
    human_decision_boundaries: [],
    rollback_expectation: '',
    ...over,
  };
}

const patterns = compileSecretPatterns(loadPolicy('policy').secretPatterns);

async function gatesOn(
  files: Record<string, string | null>,
  over: Partial<GateInput> = {},
  baseFiles: Record<string, string> = { 'src/a.ts': 'a\n' },
) {
  const { dir, base } = makeRepo(baseFiles);
  const git = new RealGit(dir);
  const wt = join(tempDir(), 'wt');
  await git.addWorktree(wt, null, base);
  for (const [p, c] of Object.entries(files)) {
    if (c === null) rmSync(join(wt, p), { force: true });
    else writeTree(wt, { [p]: c });
  }
  const snap = await git.snapshot(wt, 'refs/ecp/r/T1/1', base, 'snapshot');
  const checkout = join(tempDir(), 'co');
  await git.addWorktree(checkout, null, snap.commit);
  const spec = (over.spec as Spec) ?? makeSpec();
  const input: GateInput = {
    git,
    runner: new RealCommandRunner(),
    store: new MemRunStore(),
    spec,
    subject: 'T1',
    attemptN: 1,
    allowed: ['**'],
    forbidden: [],
    base,
    commit: snap.commit,
    tree: snap.tree,
    checkout,
    requiredTests: spec.required_tests,
    requiredTestIds: spec.required_tests.map((t) => t.id),
    runFull: false,
    fullRuns: 1,
    baselineFullSignature: null,
    secretPatterns: patterns,
    waivers: [],
    ...over,
  };
  const out = await runGates(input);
  const get = (id: string) => out.results.find((r) => r.id === id);
  return { out, get, git, wt, base, snap, checkout, input };
}

describe('H-SCOPE', () => {
  it('passes inside allowed paths', async () => {
    const { get } = await gatesOn({ 'src/b.ts': 'b\n' }, { allowed: ['src/**'] });
    expect(get('H-SCOPE')?.status).toBe('PASS');
  });
  it('fails outside allowed paths and on a forbidden path', async () => {
    const a = await gatesOn({ 'other/b.ts': 'b\n' }, { allowed: ['src/**'] });
    expect(a.get('H-SCOPE')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('hard_repairable');
    const b = await gatesOn(
      { 'src/x.ts': 'x\n' },
      { allowed: ['src/**'], forbidden: ['src/x.ts'] },
    );
    expect(b.get('H-SCOPE')?.status).toBe('FAIL');
  });
});
describe('H-CONTROL', () => {
  it('passes on ordinary files', async () => {
    const { get } = await gatesOn({ 'src/b.ts': 'b\n' });
    expect(get('H-CONTROL')?.status).toBe('PASS');
  });
  it('fails on a control file, non-repairably', async () => {
    const a = await gatesOn({ 'AGENTS.md': 'x\n' });
    expect(a.get('H-CONTROL')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('hard_nonrepairable');
  });
  it('allows a control path the spec names', async () => {
    const a = await gatesOn(
      { 'AGENTS.md': 'x\n' },
      { spec: makeSpec({ allowed_control_paths: ['AGENTS.md'] }) },
    );
    expect(a.get('H-CONTROL')?.status).toBe('PASS');
  });
});
describe('H-SECRET', () => {
  const fake = () => `AKIA${'Q'.repeat(16)}`;
  it('passes clean text', async () => {
    const { get } = await gatesOn({ 'src/b.ts': 'const a = 1;\n' });
    expect(get('H-SECRET')?.status).toBe('PASS');
  });
  it('fails on a secret in the diff, non-repairably', async () => {
    const a = await gatesOn({ 'src/b.ts': `k = "${fake()}"\n` });
    expect(a.get('H-SECRET')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('hard_nonrepairable');
  });
  it('fails on a secret in a worker artifact', async () => {
    const { dir, base } = makeRepo();
    const git = new RealGit(dir);
    const a = await gatesOn(
      { 'src/b.ts': 'x\n' },
      {
        worker: {
          worktree: dir,
          expectedHead: base,
          configBaseline: await git.configFingerprint(),
          artifactTexts: [{ name: 'stderr', text: fake() }],
        },
      },
    );
    expect(a.get('H-SECRET')?.status).toBe('FAIL');
  });
});
describe('H-NOMARKERS', () => {
  it('passes without markers', async () => {
    const { get } = await gatesOn({ 'src/b.ts': 'x\n' });
    expect(get('H-NOMARKERS')?.status).toBe('PASS');
  });
  it('fails with conflict markers', async () => {
    const a = await gatesOn({
      'src/b.ts': `${'<'.repeat(7)} ours\nx\n${'='.repeat(7)}\ny\n${'>'.repeat(7)} theirs\n`,
    });
    expect(a.get('H-NOMARKERS')?.status).toBe('FAIL');
  });
});
describe('H-TESTS-RAN and H-TESTS-PASS', () => {
  it('pass when a required test exits 0', async () => {
    const spec = makeSpec({ required_tests: [{ id: 'u', ...passCmd }] });
    const { get } = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(get('H-TESTS-RAN')?.status).toBe('PASS');
    expect(get('H-TESTS-PASS')?.status).toBe('PASS');
    expect(get('test-u')?.log_sha).toMatch(/^[0-9a-f]{64}$/);
  });
  it('H-TESTS-PASS fails on a non-zero exit', async () => {
    const spec = makeSpec({ required_tests: [{ id: 'u', ...failCmd }] });
    const a = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(a.get('H-TESTS-PASS')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('hard_repairable');
  });
  it('H-TESTS-RAN fails when a required test ID has no command to run', async () => {
    const spec = makeSpec({ required_tests: [{ id: 'u', ...passCmd }] });
    const a = await gatesOn({ 'src/b.ts': 'x\n' }, { spec, requiredTestIds: ['u', 'missing'] });
    expect(a.get('H-TESTS-RAN')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('hard_repairable');
  });
  it('never uses a shell for a command', async () => {
    const spec = makeSpec({ required_tests: [{ id: 'u', command: ['true;false'], timeout_s: 5 }] });
    const a = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(a.get('H-TESTS-PASS')?.status).toBe('FAIL');
  });
});
describe('H-TYPECHECK and H-BUILD', () => {
  it('pass on exit 0', async () => {
    const spec = makeSpec({ gate_commands: { typecheck: passCmd, build: passCmd } });
    const { get } = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(get('H-TYPECHECK')?.status).toBe('PASS');
    expect(get('H-BUILD')?.status).toBe('PASS');
  });
  it('fail on non-zero', async () => {
    const spec = makeSpec({ gate_commands: { typecheck: failCmd, build: failCmd } });
    const { get } = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(get('H-TYPECHECK')?.status).toBe('FAIL');
    expect(get('H-BUILD')?.status).toBe('FAIL');
  });
});
describe('H-GITCFG and H-NOCOMMIT', () => {
  it('pass with an unchanged config and HEAD', async () => {
    const { dir, base } = makeRepo();
    const git = new RealGit(dir);
    expect(checkGitCfg(await git.configFingerprint(), await git.configFingerprint()).ok).toBe(true);
    expect(checkNoCommit(base, await git.headCommit()).ok).toBe(true);
  });
  it('fail on a tampered config, a new hook, and a moved HEAD', async () => {
    const { dir, base } = makeRepo();
    const git = new RealGit(dir);
    const before = await git.configFingerprint();
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\n');
    expect(checkGitCfg(before, await git.configFingerprint()).ok).toBe(false);
    const b2 = await git.configFingerprint();
    writeFileSync(join(dir, '.git/config'), '[core]\n\tbare = false\n');
    expect(checkGitCfg(b2, await git.configFingerprint()).ok).toBe(false);
    expect(checkNoCommit('0'.repeat(40), base).ok).toBe(false);
  });
  it('run on a worker and classify as non-repairable', async () => {
    const { dir, base } = makeRepo();
    const git = new RealGit(dir);
    const a = await gatesOn(
      { 'src/b.ts': 'x\n' },
      {
        worker: {
          worktree: dir,
          expectedHead: '0'.repeat(40),
          configBaseline: await git.configFingerprint(),
          artifactTexts: [],
        },
      },
    );
    expect(base).toBeTruthy();
    expect(a.get('H-NOCOMMIT')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('hard_nonrepairable');
  });
});
describe('H-TREE-ID', () => {
  it('passes when commands leave the tree alone', async () => {
    const { get, out } = await gatesOn({ 'src/b.ts': 'x\n' });
    expect(get('H-TREE-ID')?.status).toBe('PASS');
    expect(out.tree_changed).toBeNull();
  });
  it('fails when a command rewrites a tracked file, and names the path', async () => {
    const rewrite = {
      command: [NODE, '-e', 'require("fs").writeFileSync("src/a.ts","changed\\n")'],
      timeout_s: 30,
    };
    const spec = makeSpec({ required_tests: [{ id: 'u', ...rewrite }] });
    const a = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(a.get('H-TREE-ID')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('tree_changed');
    expect(a.out.tree_changed).toEqual(['src/a.ts']);
  });
  it('compares by hash', () => {
    expect(checkTreeId('a', 'a').ok).toBe(true);
    expect(checkTreeId('a', 'b').ok).toBe(false);
  });
});
describe('S-REGRESSION', () => {
  it('passes when the full suite passes', async () => {
    const { get } = await gatesOn({ 'src/b.ts': 'x\n' }, { runFull: true });
    expect(get('S-REGRESSION')?.status).toBe('PASS');
  });
  it('fails softly with a new signature', async () => {
    const spec = makeSpec({ full_test_command: failCmd });
    const a = await gatesOn({ 'src/b.ts': 'x\n' }, { spec, runFull: true });
    expect(a.get('S-REGRESSION')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('soft_failed');
  });
  it('passes on the same signature as the baseline', async () => {
    const spec = makeSpec({ full_test_command: failCmd });
    const sig = gateSignature('S-REGRESSION', 'Error: boom\n');
    const a = await gatesOn(
      { 'src/b.ts': 'x\n' },
      { spec, runFull: true, baselineFullSignature: sig },
    );
    expect(a.get('S-REGRESSION')?.status).toBe('PASS');
  });
  it('reports WAIVED on a matching waiver, and FAIL on a different signature', async () => {
    const spec = makeSpec({ full_test_command: failCmd });
    const sig = gateSignature('S-REGRESSION', 'Error: boom\n');
    const w = await gatesOn(
      { 'src/b.ts': 'x\n' },
      { spec, runFull: true, waivers: [{ gate_id: 'S-REGRESSION', signature_element: sig }] },
    );
    expect(w.get('S-REGRESSION')?.status).toBe('WAIVED');
    expect(w.out.classification).toBe('passed');
    const n = await gatesOn(
      { 'src/b.ts': 'x\n' },
      { spec, runFull: true, waivers: [{ gate_id: 'S-REGRESSION', signature_element: 'other' }] },
    );
    expect(n.get('S-REGRESSION')?.status).toBe('FAIL');
  });
});
describe('S-TESTCHANGE', () => {
  const base = { 'test/a.test.ts': 'it("x", () => { expect(1).toBe(1); expect(2).toBe(2); });\n' };
  it('passes when tests are added or unchanged', async () => {
    const { get } = await gatesOn({ 'test/b.test.ts': 'it("y", () => {});\n' }, {}, base);
    expect(get('S-TESTCHANGE')?.status).toBe('PASS');
  });
  it('fails on deleted, skipped and loosened, one element each', async () => {
    const del = await gatesOn({ 'test/a.test.ts': null }, {}, base);
    expect(del.get('S-TESTCHANGE')?.elements).toEqual(['test/a.test.ts|deleted']);
    const skip = await gatesOn(
      { 'test/a.test.ts': 'it.skip("x", () => { expect(1).toBe(1); expect(2).toBe(2); });\n' },
      {},
      base,
    );
    expect(skip.get('S-TESTCHANGE')?.elements).toEqual(['test/a.test.ts|skipped']);
    const loose = await gatesOn(
      { 'test/a.test.ts': 'it("x", () => { expect(1).toBe(1); });\n' },
      {},
      base,
    );
    expect(loose.get('S-TESTCHANGE')?.elements).toEqual(['test/a.test.ts|loosened']);
    expect(loose.out.classification).toBe('soft_failed');
  });
  it('a waiver covers only its own element', async () => {
    const two = { 'test/a.test.ts': 'expect(1);\n', 'test/b.test.ts': 'expect(2);\n' };
    const a = await gatesOn(
      { 'test/a.test.ts': null, 'test/b.test.ts': null },
      { waivers: [{ gate_id: 'S-TESTCHANGE', signature_element: 'test/a.test.ts|deleted' }] },
      two,
    );
    expect(a.get('S-TESTCHANGE')?.status).toBe('FAIL');
    expect(a.get('S-TESTCHANGE')?.uncovered).toEqual(['test/b.test.ts|deleted']);
  });
});
describe('S-DEP', () => {
  const base = { 'package.json': '{"dependencies":{"a":"1.0.0"}}\n' };
  it('passes with no new dependency', async () => {
    const { get } = await gatesOn({ 'src/x.ts': 'x\n' }, {}, base);
    expect(get('S-DEP')?.status).toBe('PASS');
  });
  it('fails on a new dependency, per name and version', async () => {
    const a = await gatesOn(
      { 'package.json': '{"dependencies":{"a":"1.0.0","b":"2.0.0"}}\n' },
      {},
      base,
    );
    expect(a.get('S-DEP')?.elements).toEqual(['b@2.0.0']);
  });
});
describe('S-LINT', () => {
  it('passes on exit 0', async () => {
    const spec = makeSpec({ gate_commands: { lint: passCmd } });
    const { get } = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(get('S-LINT')?.status).toBe('PASS');
  });
  it('fails softly on non-zero', async () => {
    const spec = makeSpec({ gate_commands: { lint: failCmd } });
    const a = await gatesOn({ 'src/b.ts': 'x\n' }, { spec });
    expect(a.get('S-LINT')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('soft_failed');
  });
});
describe('H-CLAIMS', () => {
  it('runs last and passes on a clean result', async () => {
    const a = await gatesOn(
      { 'src/b.ts': 'x\n' },
      { claims: async () => ({ ok: true, detail: 'ok' }) },
    );
    expect(a.out.results[a.out.results.length - 1].id).toBe('H-CLAIMS');
    expect(a.get('H-CLAIMS')?.status).toBe('PASS');
  });
  it('fails repairably on a contradicted claim', async () => {
    const a = await gatesOn(
      { 'src/b.ts': 'x\n' },
      { claims: async () => ({ ok: false, detail: 'contradicted' }) },
    );
    expect(a.get('H-CLAIMS')?.status).toBe('FAIL');
    expect(a.out.classification).toBe('hard_repairable');
  });
});
describe('hard gates that are pure checks', () => {
  it('H-REPO', () => {
    expect(checkRepo('a', 'a', true).ok).toBe(true);
    expect(checkRepo('a', 'b', true).ok).toBe(false);
    expect(checkRepo('a', 'a', false).ok).toBe(false);
  });
  it('H-CLEAN', () => {
    expect(checkClean(true).ok).toBe(true);
    expect(checkClean(false).ok).toBe(false);
  });
  it('H-NOPUSH', () => {
    expect(checkNoPush([]).ok).toBe(true);
    expect(checkNoPush(['origin']).ok).toBe(false);
  });
  it('H-SPEC', () => {
    expect(checkSpecLock('a', 'a').ok).toBe(true);
    expect(checkSpecLock('a', 'b').ok).toBe(false);
  });
  it('H-REVIEW', () => {
    const good = { slot: 0, valid: true, independent: true, verdict: 'PASS' };
    expect(checkReview([good], 1).ok).toBe(true);
    expect(checkReview([], 1).ok).toBe(false);
    expect(checkReview([{ ...good, valid: false }], 1).ok).toBe(false);
    expect(checkReview([{ ...good, independent: false }], 1).ok).toBe(false);
    expect(checkReview([good], 2).ok).toBe(false);
  });
  it('H-REVIEW-RO', () => {
    expect(checkReviewReadOnly('a', 'a').ok).toBe(true);
    expect(checkReviewReadOnly('a', 'b').ok).toBe(false);
  });
  it('H-EVIDENCE', () => {
    const rec = { gate: 'g', log_sha: 'x', tree_hash: 't' };
    expect(checkEvidence([rec], 't', () => true).ok).toBe(true);
    expect(checkEvidence([{ ...rec, log_sha: null }], 't', () => true).ok).toBe(false);
    expect(checkEvidence([rec], 'other', () => true).ok).toBe(false);
    expect(checkEvidence([rec], 't', () => false).ok).toBe(false);
  });
  it('H-AC', () => {
    const c = { id: 'AC-1', human_reserved: false, evidenced: true };
    expect(checkAc([c], []).ok).toBe(true);
    expect(checkAc([{ ...c, evidenced: false }], []).ok).toBe(false);
    expect(checkAc([{ ...c, evidenced: false, human_reserved: true }], []).ok).toBe(true);
    expect(checkAc([{ ...c, evidenced: false }], ['AC-1']).ok).toBe(true);
  });
  it('H-CAP', () => {
    expect(checkCap(1, 2).ok).toBe(true);
    expect(checkCap(2, 2).ok).toBe(false);
  });
  it('H-LEDGER', () => {
    const store = new MemLedgerStore();
    const l = new Ledger(store, 'r', () => '2026-01-01T00:00:00.000Z');
    l.append('heartbeat', null, {});
    l.append('heartbeat', null, {});
    expect(checkLedger(() => loadLedger(store)).ok).toBe(true);
    store.content = store.content.replace('"seq":1', '"seq":7');
    expect(checkLedger(() => loadLedger(store)).ok).toBe(false);
  });
});
describe('real git driver', () => {
  let git: RealGit;
  let base: string;
  let wt: string;
  beforeAll(async () => {
    const r = makeRepo({ 'a.txt': 'a\nb\nc\n', '.gitignore': 'ignored.txt\n' });
    git = new RealGit(r.dir);
    base = r.base;
    wt = join(tempDir(), 'wt');
    await git.addWorktree(wt, 'ecp/r/T1', base);
  });
  it('hashes tracked and untracked content, not ignored files', async () => {
    const t0 = await git.worktreeTree(wt);
    expect(t0).toBe(await git.treeOf(base));
    writeTree(wt, { 'ignored.txt': 'x' });
    expect(await git.worktreeTree(wt)).toBe(t0);
    writeTree(wt, { 'new.txt': 'x' });
    expect(await git.worktreeTree(wt)).not.toBe(t0);
    rmSync(join(wt, 'new.txt'));
    rmSync(join(wt, 'ignored.txt'));
  });
  it('snapshots invisibly, and leaves HEAD and the branch alone', async () => {
    writeTree(wt, { 'b.txt': 'b' });
    const s = await git.snapshot(wt, 'refs/ecp/r/T1/1', base, 'm');
    expect(await git.resolveRef('refs/ecp/r/T1/1')).toBe(s.commit);
    expect(await git.worktreeHead(wt)).toBe(base);
    expect(await git.treeOf(s.commit)).toBe(s.tree);
    await git.resetWorktree(wt, base);
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
  });
  it('keeps a tracked file that matches .gitignore in the tree hash', async () => {
    const r = makeRepo({ 'a.txt': 'x\n', '.gitignore': 'build.txt\n' });
    writeTree(r.dir, { 'build.txt': 'tracked anyway\n' });
    sh(r.dir, 'add', '-f', 'build.txt');
    sh(r.dir, 'commit', '-qm', 'tracked');
    const head = sh(r.dir, 'rev-parse', 'HEAD');
    const g = new RealGit(r.dir);
    const w = join(tempDir(), 'w');
    await g.addWorktree(w, null, head);
    expect(await g.worktreeTree(w)).toBe(await g.treeOf(head));
    writeTree(w, { 'build.txt': 'changed\n' });
    expect(await g.worktreeTree(w)).not.toBe(await g.treeOf(head));
  });
  it('sees a same-size edit made at once, past any cached stat data', async () => {
    const r = makeRepo({ 'a.txt': 'one\n' });
    const g = new RealGit(r.dir);
    const w = join(tempDir(), 'w');
    await g.addWorktree(w, null, r.base);
    for (let i = 0; i < 25; i++) {
      const text = `${String(i).padStart(3, '0')}\n`;
      writeTree(w, { 'a.txt': text });
      const s = await g.snapshot(w, `refs/x/${i}`, r.base, 'm');
      expect(await g.readFile(s.commit, 'a.txt')).toBe(text);
      await g.resetWorktree(w, r.base);
      expect(await g.worktreeTree(w)).toBe(await g.treeOf(r.base));
    }
  });
  it('merges clean trees, and reports conflicts with markers', async () => {
    const r = makeRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
    const g = new RealGit(r.dir);
    const w = join(tempDir(), 'w');
    await g.addWorktree(w, null, r.base);
    writeTree(w, { 'a.txt': 'ONE\n' });
    const a = await g.snapshot(w, 'refs/x/a', r.base, 'a');
    await g.resetWorktree(w, r.base);
    writeTree(w, { 'b.txt': 'TWO\n' });
    const b = await g.snapshot(w, 'refs/x/b', r.base, 'b');
    await g.resetWorktree(w, r.base);
    writeTree(w, { 'a.txt': 'OTHER\n' });
    const c = await g.snapshot(w, 'refs/x/c', r.base, 'c');
    const clean = await g.mergeTrees(a.commit, b.commit);
    expect(clean.clean).toBe(true);
    const conflict = await g.mergeTrees(a.commit, c.commit);
    expect(conflict.clean).toBe(false);
    if (!conflict.clean) expect(conflict.conflicted).toEqual(['a.txt']);
  });
  it('disables hooks a worker might have written', async () => {
    const r = makeRepo();
    const marker = join(tempDir(), 'hook-ran');
    writeFileSync(join(r.dir, '.git/hooks/post-commit'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    const g = new RealGit(r.dir);
    const c = await g.commitTree(await g.treeOf(r.base), [r.base], 'x');
    await g.updateRef('refs/heads/x', c);
    expect(existsSync(marker)).toBe(false);
  });
});
describe('helpers', () => {
  it('matches globs', () => {
    expect(globMatch('src/**', 'src/a/b.ts')).toBe(true);
    expect(globMatch('src/*', 'src/a/b.ts')).toBe(false);
    expect(globMatch('**/x.ts', 'x.ts')).toBe(true);
    expect(globMatch('**/x.ts', 'a/b/x.ts')).toBe(true);
    expect(globMatch('.claude/', '.claude/a')).toBe(true);
    expect(globMatch('a?.ts', 'ab.ts')).toBe(true);
  });
  it('normalises signatures past timestamps, durations, addresses and paths', () => {
    const a = gateSignature('G', '2026-01-01T00:00:00Z Error at /tmp/a/b.ts 12ms 0xdeadbeef\n');
    const b = gateSignature('G', '2027-02-02T01:01:01Z Error at /var/x/b.ts 99ms 0xabc\n');
    expect(a).toBe(b);
    expect(gateSignature('G', 'Error one')).not.toBe(gateSignature('G', 'Error two'));
  });
});
