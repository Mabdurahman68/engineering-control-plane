import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { pushArgv } from '../../src/publish/publisher.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { runReal } from '../support/harness.ts';
import { fakeSecret, publishRun, remoteHas, remoteRef } from '../support/publish.ts';
import { ofTypeReal } from '../support/real-events.ts';

const RULE = 'B4-FROZEN';
const dest = 'refs/heads/ecp/run1/integration';

describe('the frozen commit', () => {
  it('the branch moves after scanning, with a secret: the pushed commit is still the frozen one', async () => {
    const { sim, bare, publisher } = publishRun();
    const gates = publisher.gates.bind(publisher);
    let secretCommit = '';
    publisher.gates = async (c, sha) => {
      const out = await gates(c, sha);
      // After every scan has passed, something moves the integration branch to a new commit.
      const blob = execFileSync('git', ['-C', sim.repo, 'hash-object', '-w', '--stdin'], {
        input: `k = "${fakeSecret()}"\n`,
        encoding: 'utf8',
      }).trim();
      const tree = execFileSync('git', ['-C', sim.repo, 'mktree'], {
        input: `100644 blob ${blob}\tleak.txt\n`,
        encoding: 'utf8',
      }).trim();
      secretCommit = execFileSync(
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
          sha,
          '-m',
          'moved',
        ],
        { encoding: 'utf8' },
      ).trim();
      execFileSync('git', [
        '-C',
        sim.repo,
        'update-ref',
        'refs/heads/ecp/run1/integration',
        secretCommit,
      ]);
      return out;
    };
    const exit = await runReal(sim);
    const frozen = sim.engine.s.publish.frozen_sha as string;
    expect(secretCommit).not.toBe(frozen);
    assertNotForbidden(
      RULE,
      remoteRef(bare, dest) !== frozen,
      'the remote is not at the frozen commit',
    );
    assertNotForbidden(RULE, remoteHas(bare, secretCommit), 'the moved commit reached the remote');
    expect(exit.state).toBe('PR_OPENED');
  });
  it('the argv holds a full SHA as the source, never a branch name', () => {
    const sha = 'a'.repeat(40);
    expect(pushArgv('url', sha, 'ecp/r/integration')).toEqual([
      'push',
      'url',
      `${sha}:refs/heads/ecp/r/integration`,
    ]);
    for (const bad of ['main', 'HEAD', 'ecp/r/integration', `+${sha}`, 'a'.repeat(39)]) {
      expect(() => pushArgv('url', bad, 'x'), bad).toThrow(/not a full SHA/);
    }
    expect(() => pushArgv('url', sha, '+x')).toThrow(/forced/);
  });
  it('push.verified fails when the remote differs', async () => {
    const { sim, publisher, gh } = publishRun();
    publisher.verifyPush = async () => ({
      ok: false,
      detail: 'remote is at something else',
      observed: 'b'.repeat(40),
    });
    const exit = await runReal(sim);
    assertNotForbidden(RULE, exit.state === 'PR_OPENED', 'a mismatched remote counted as pushed');
    expect(exit.state).toBe('PUSH_BLOCKED');
    expect(ofTypeReal(sim, 'push.verified').length).toBe(0);
    expect(gh.calls().filter((c) => c.startsWith('pr create'))).toEqual([]);
  });
  it('every check reads the SHA frozen first', async () => {
    const { sim } = publishRun();
    await runReal(sim);
    const frozen = ofTypeReal(sim, 'push.sha_frozen')[0].data.sha;
    expect(ofTypeReal(sim, 'push.gate_started')[0].data.sha).toBe(frozen);
    expect(ofTypeReal(sim, 'push.intent')[0].data.sha).toBe(frozen);
    expect(ofTypeReal(sim, 'push.verified')[0].data.sha).toBe(frozen);
    expect(frozen).toMatch(/^[0-9a-f]{40}$/);
  });
});
