import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/core/engine.ts';
import { SimulatedKill } from '../../src/core/ports.ts';
import { validatePrs } from '../../src/publish/publisher.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { runReal } from '../support/harness.ts';
import { publishRun, remoteRef } from '../support/publish.ts';
import { ofTypeReal } from '../support/real-events.ts';

const RULE = 'B4-PR';
const SHA = 'a'.repeat(40);
const good = {
  url: 'u',
  isDraft: true,
  state: 'OPEN',
  baseRefName: 'main',
  headRefName: 'h',
  headRefOid: SHA,
  isCrossRepository: false,
};
const expected = { base: 'main', head: 'h', sha: SHA };

describe('validating a pull request', () => {
  it('a fully matching one passes', () => {
    expect(validatePrs([good], expected).ok).toBe(true);
  });
  it.each([
    ['wrong base', { baseRefName: 'other' }],
    ['a different head SHA', { headRefOid: 'b'.repeat(40) }],
    ['a different head branch', { headRefName: 'other' }],
    ['not draft', { isDraft: false }],
    ['closed', { state: 'CLOSED' }],
    ['merged', { state: 'MERGED' }],
    ['from a fork', { isCrossRepository: true }],
  ])('%s fails', (_n, over) => {
    assertNotForbidden(
      RULE,
      validatePrs([{ ...good, ...over }], expected).ok,
      'a mismatched PR passed',
    );
  });
  it('none, or several, fail', () => {
    expect(validatePrs([], expected).ok).toBe(false);
    assertNotForbidden(RULE, validatePrs([good, good], expected).ok, 'several PRs passed');
  });
});

function crashAtPrIntent(o: any = {}) {
  const run = publishRun(o);
  (run.sim.ports as any).failpoint = (n: string) => {
    if (n === 'after:pr.intent') throw new SimulatedKill(n);
  };
  return run;
}
const resume = async (sim: any) => {
  sim.ports.failpoint = () => {};
  sim.engine = new Engine(
    { runId: 'run1', spec: sim.spec, specSha: sim.specSha, policySha: 'b'.repeat(64) },
    sim.ports,
  );
  sim.engine.loadForResume();
  await sim.engine.resumeRun({ policySha: 'b'.repeat(64) });
  return sim.engine.loop();
};

describe('recovery after a crash at pr.intent', () => {
  const headSha = (bare: string) => remoteRef(bare, 'refs/heads/ecp/run1/integration') as string;
  const base = (bare: string) => ({
    url: 'https://example.invalid/pr/9',
    isDraft: true,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'ecp/run1/integration',
    headRefOid: headSha(bare),
    isCrossRepository: false,
  });
  const cases: [string, (b: string) => any[]][] = [
    ['wrong base', (b) => [{ ...base(b), baseRefName: 'other' }]],
    ['a different head SHA', (b) => [{ ...base(b), headRefOid: 'b'.repeat(40) }]],
    ['not draft', (b) => [{ ...base(b), isDraft: false }]],
    ['closed', (b) => [{ ...base(b), state: 'CLOSED' }]],
    ['from a fork', (b) => [{ ...base(b), isCrossRepository: true }]],
    ['several PRs', (b) => [base(b), { ...base(b), url: 'second' }]],
  ];
  it.each(cases)('a found PR with %s blocks, with no edit, close or second PR', async (_n, prs) => {
    const { sim, bare, gh } = crashAtPrIntent();
    await expect(runReal(sim)).rejects.toBeInstanceOf(SimulatedKill);
    gh.set({ prs: prs(bare) });
    const exit = await resume(sim);
    assertNotForbidden(RULE, exit.state === 'PR_OPENED', 'a mismatched PR was accepted');
    expect(exit.state).toBe('PUSH_BLOCKED');
    const calls = gh.calls();
    assertNotForbidden(
      RULE,
      calls.some((c) => /^pr (create|edit|close|merge|review)/.test(c)),
      `calls: ${calls}`,
    );
  });
  it('a fully matching one is recorded', async () => {
    const { sim, bare, gh } = crashAtPrIntent();
    await expect(runReal(sim)).rejects.toBeInstanceOf(SimulatedKill);
    gh.set({ prs: [base(bare)] });
    const exit = await resume(sim);
    expect(exit.state).toBe('PR_OPENED');
    expect(sim.engine.s.publish.pr_url).toBe('https://example.invalid/pr/9');
    expect(gh.calls().filter((c) => c.startsWith('pr create'))).toEqual([]);
    expect(ofTypeReal(sim, 'pr.validated').length).toBe(1);
  });
  it('none found: it creates one, then validates', async () => {
    const { sim, gh } = crashAtPrIntent();
    await expect(runReal(sim)).rejects.toBeInstanceOf(SimulatedKill);
    const exit = await resume(sim);
    expect(exit.state).toBe('PR_OPENED');
    expect(gh.calls().filter((c) => c.startsWith('pr create')).length).toBe(1);
  });
});
