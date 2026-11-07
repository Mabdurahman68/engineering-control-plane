import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadLedger } from '../../../src/ledger/ledger.ts';
import { makeReal, runReal } from '../../support/harness.ts';

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

describe('three mock tasks on real git', () => {
  it('takes every task to TASK_PASSED, in a real repository', async () => {
    const sim = makeReal();
    const exit = await runReal(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    for (const t of ['T1', 'T2', 'T3']) {
      const rec = sim.engine.s.tasks[t];
      expect(rec.state).toBe('TASK_PASSED');
      // The branch exists, holds one squashed commit, and carries the trailers.
      const branch = `ecp/run1/${t}`;
      expect(git(sim.repo, 'rev-parse', branch)).toBe(rec.commit);
      const body = git(sim.repo, 'log', '-1', '--format=%B', branch);
      expect(body).toContain(`Task: ${t}`);
      expect(body).toContain('Spec: SPEC-T');
      expect(body).toContain('Run: run1');
      // Snapshots are refs, not branches.
      expect(git(sim.repo, 'rev-parse', `refs/ecp/run1/${t}/1`)).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(sim.engine.s.tasks.T3.base_commit).toBe(sim.engine.s.tasks.T1.commit);
    expect(loadLedger(sim.ledger).events.filter((e) => e.type === 'invariant.violation')).toEqual(
      [],
    );
  });
  it('leaves the target branch and working tree untouched', async () => {
    const sim = makeReal();
    await runReal(sim);
    expect(git(sim.repo, 'rev-parse', 'HEAD')).toBe(sim.base);
    expect(git(sim.repo, 'status', '--porcelain')).toBe('');
  });
  it('has real merges on the integration branch, each with both parents', async () => {
    const sim = makeReal();
    await runReal(sim);
    const tip = git(sim.repo, 'rev-parse', 'ecp/run1/integration');
    const parents = git(sim.repo, 'log', '-1', '--format=%P', tip).split(' ');
    expect(parents.length).toBe(2);
    for (const f of ['src/t1/T1-1.txt', 'src/t2/T2-1.txt', 'src/t3/T3-1.txt']) {
      expect(git(sim.repo, 'cat-file', '-t', `${tip}:${f}`)).toBe('blob');
    }
  });
  it('removes worktrees at the end, and keeps branches and snapshot refs', async () => {
    const sim = makeReal();
    await runReal(sim);
    const list = git(sim.repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
    expect(list.length).toBe(1);
    expect(git(sim.repo, 'for-each-ref', '--format=%(refname)', 'refs/ecp/')).toContain(
      'refs/ecp/run1/T1/1',
    );
  });
});
