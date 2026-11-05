import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { runReal } from '../support/harness.ts';
import { Engine } from '../../src/core/engine.ts';
import { publishRun, remoteRef } from '../support/publish.ts';
import { ofTypeReal } from '../support/real-events.ts';

const RULE = 'B4-BASE';
const dest = 'refs/heads/ecp/run1/integration';

function moveBase(sim: any, bare: string) {
  const tree = execFileSync('git', ['-C', sim.repo, 'rev-parse', `${sim.base}^{tree}`], {
    encoding: 'utf8',
  }).trim();
  const moved = execFileSync(
    'git',
    [
      '-C',
      sim.repo,
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@example.invalid',
      'commit-tree',
      tree,
      '-p',
      sim.base,
      '-m',
      'moved on',
    ],
    { encoding: 'utf8' },
  ).trim();
  execFileSync('git', ['-C', sim.repo, 'push', '-q', bare, `${moved}:refs/heads/main`]);
  return moved;
}
const again = async (sim: any, acceptBase: string) => {
  sim.engine = new Engine(
    { runId: 'run1', spec: sim.spec, specSha: sim.specSha, policySha: 'b'.repeat(64) },
    sim.ports,
  );
  sim.engine.loadForResume();
  sim.engine.retryPublish(acceptBase);
  return sim.engine.loop();
};

describe('base drift', () => {
  it('a moved remote base blocks, with no notice-based exception', async () => {
    const { sim, bare } = publishRun();
    moveBase(sim, bare);
    const exit = await runReal(sim);
    assertNotForbidden(RULE, exit.state !== 'PUSH_BLOCKED', 'the push went ahead on a moved base');
    assertNotForbidden(RULE, remoteRef(bare, dest) !== null, 'the branch reached the remote');
    expect(ofTypeReal(sim, 'push.gate_failed')[0].data.reason).toContain('H-PUSH-BASE');
  });
  it('--accept-base for a different SHA blocks', async () => {
    const { sim, bare } = publishRun();
    moveBase(sim, bare);
    await runReal(sim);
    const exit = await again(sim, 'c'.repeat(40));
    assertNotForbidden(
      RULE,
      exit.state !== 'PUSH_BLOCKED',
      'acceptance of another commit let it through',
    );
    assertNotForbidden(RULE, remoteRef(bare, dest) !== null, 'the branch reached the remote');
  });
  it('--accept-base for that exact SHA re-scans, then proceeds, and records it', async () => {
    const { sim, bare } = publishRun();
    const moved = moveBase(sim, bare);
    await runReal(sim);
    const before = ofTypeReal(sim, 'push.gate_started').length;
    const exit = await again(sim, moved);
    expect(exit.state).toBe('PR_OPENED');
    expect(ofTypeReal(sim, 'push.gate_started').length).toBe(before + 1);
    expect(ofTypeReal(sim, 'publish.base_accepted')[0].data.sha).toBe(moved);
    expect(remoteRef(bare, dest)).toBe(sim.engine.s.publish.frozen_sha);
  });
});
