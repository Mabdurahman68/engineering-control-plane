import { describe, expect, it } from 'vitest';
import type { ShadowProposal } from '../../src/contracts/index.ts';
import { replayDecision } from '../../src/shadow/replay.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { VALID } from '../unit/contracts/fixtures.ts';

const RULE = 'R-C6-REPLAY';
const proposal = (o: any = {}): ShadowProposal =>
  ({ ...structuredClone(VALID.shadow_proposal), ...o }) as ShadowProposal;

function ports(over: any = {}) {
  const log: string[] = [];
  const dirs: Record<string, Record<string, string>> = {};
  return {
    log,
    dirs,
    isDisposableFixture: true,
    async restore(tree: string, label: string) {
      log.push(`restore ${tree} ${label}`);
      dirs[label] = { tree };
      return label;
    },
    async runAction(action: string, _t: string | null, dir: string) {
      log.push(`run ${action} in ${dir}`);
      dirs[dir].action = action;
    },
    async hiddenChecks(dir: string) {
      log.push(`score ${dir}`);
      return { passed: dirs[dir].action === 'repair' ? 3 : 1, total: 3 };
    },
    ...over,
  };
}

describe('paired replay', () => {
  it('restores the subject tree twice, runs both actions, and scores with hidden checks neither sees', async () => {
    const p = ports();
    const r = await replayDecision(proposal(), p, 'RP-1');
    expect(p.log).toEqual([
      `restore ${'a'.repeat(40)} coordinator`,
      `restore ${'a'.repeat(40)} shadow`,
      'run proceed_to_review in coordinator',
      'run repair in shadow',
      'score coordinator',
      'score shadow',
    ]);
    expect(r).toEqual({
      status: 'REPLAYED',
      replay_id: 'RP-1',
      coordinator: { action: 'proceed_to_review', passed: 1, total: 3 },
      shadow: { action: 'repair', passed: 3, total: 3 },
    });
    // Each path ran before either was scored, so neither saw the checks.
    assertNotForbidden(
      RULE,
      p.log.findIndex((x: string) => x.startsWith('score')) <
        p.log.findIndex((x: string) => x === 'run repair in shadow'),
      'a path saw the checks',
    );
  });
  it('refuses a private target', async () => {
    const p = ports({ isDisposableFixture: false });
    const r = await replayDecision(proposal(), p, 'RP-1');
    assertNotForbidden(RULE, r.status === 'REPLAYED', 'a private target was replayed');
    expect(p.log).toEqual([]);
  });
  it('refuses an illegal proposal', async () => {
    const bad = proposal();
    bad.comparison.proposal_legal = false;
    const p = ports();
    const r = await replayDecision(bad, p, 'RP-1');
    assertNotForbidden(RULE, r.status === 'REPLAYED', 'an illegal proposal was replayed');
    expect(p.log).toEqual([]);
  });
  it('has nothing to replay when they agreed, or when there is no proposal', async () => {
    const agreed = proposal();
    agreed.comparison.match = true;
    expect((await replayDecision(agreed, ports(), 'x')).status).toBe('NOT_REPLAYABLE');
    const none = proposal();
    none.shadow.status = 'SHADOW_UNAVAILABLE';
    none.shadow.report = null;
    expect((await replayDecision(none, ports(), 'x')).status).toBe('NOT_REPLAYABLE');
  });
});
