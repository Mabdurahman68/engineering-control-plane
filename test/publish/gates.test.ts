import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GateFailure, runPushGates } from '../../src/publish/gate.ts';
import { loadDenyList, loadForbidden } from '../../src/publish/lists.ts';
import { assertNotForbidden } from '../support/assert.ts';
import {
  DENIED_NAME,
  fakeSecret,
  gateRepo,
  secretPatterns,
  writeLists,
} from '../support/publish.ts';
import { sh } from '../support/repo.ts';

function input(r: ReturnType<typeof gateRepo>, frozen: string, over: any = {}) {
  return {
    repo: r.dir,
    remoteUrl: r.bare,
    repoName: 'owner/name',
    baseBranch: 'main',
    baseCommit: r.base,
    frozen,
    destination: 'ecp/r1/integration',
    destinationRule: { prefix: 'ecp/r1/' },
    reviewedTree: sh(r.dir, 'rev-parse', `${frozen}^{tree}`),
    allowedPaths: ['src/**'],
    acceptedBase: null,
    prTitle: 'title',
    prBody: 'body',
    deny: loadDenyList(join(r.home, 'policy/name-deny.txt')),
    forbidden: loadForbidden(join(r.home, 'policy/publish-forbidden.yaml')),
    secretPatterns: secretPatterns(),
    ...over,
  };
}
const has = (f: GateFailure[], id: string) => f.some((x) => x.id === id);
// The forbidden outcome here: the gate passes, so the push would go ahead.
const blocks = async (
  rule: string,
  r: ReturnType<typeof gateRepo>,
  frozen: string,
  id: string,
  over: any = {},
) => {
  const f = await runPushGates(input(r, frozen, over));
  assertNotForbidden(rule, !has(f, id), `${id} didn't fire: ${JSON.stringify(f)}`);
  return f;
};

describe('a clean candidate', () => {
  it('passes every gate', async () => {
    const r = gateRepo();
    const c = r.commit({ 'src/a.ts': 'a\n' });
    expect(await runPushGates(input(r, c))).toEqual([]);
  });
});

describe('H-PUSH-SECRET', () => {
  const RULE = 'H-PUSH-SECRET';
  it('a secret in an earlier commit, not the tip, blocks', async () => {
    const r = gateRepo();
    r.commit({ 'src/a.ts': `k = "${fakeSecret()}"\n` });
    const tip = r.commit({ 'src/a.ts': 'clean\n' });
    expect(sh(r.dir, 'show', `${tip}:src/a.ts`)).toBe('clean');
    await blocks(RULE, r, tip, RULE);
  });
  it('a secret in a commit message blocks', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' }, `oops ${fakeSecret()}`);
    await blocks(RULE, r, tip, RULE);
  });
  it('a secret in author fields blocks', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' }, 'm', { GIT_AUTHOR_NAME: fakeSecret() });
    await blocks(RULE, r, tip, RULE);
  });
  it('a secret in the PR title or body blocks', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' });
    await blocks(RULE, r, tip, RULE, { prTitle: fakeSecret() });
    await blocks(RULE, r, tip, RULE, { prBody: `here: ${fakeSecret()}` });
  });
});

describe('H-PUSH-NAMES', () => {
  const RULE = 'H-PUSH-NAMES';
  it('a private name in an author email, commit message or PR body blocks', async () => {
    const r = gateRepo();
    await blocks(
      RULE,
      r,
      r.commit({ 'src/a.ts': 'a\n' }, 'm', { GIT_AUTHOR_EMAIL: `${DENIED_NAME}@example.invalid` }),
      RULE,
    );
    await blocks(RULE, r, r.commit({ 'src/b.ts': 'b\n' }, `about ${DENIED_NAME}`), RULE);
    const clean = gateRepo();
    await blocks(RULE, clean, clean.commit({ 'src/a.ts': 'a\n' }), RULE, {
      prBody: `for ${DENIED_NAME}`,
    });
  });
  it('a name in file content or a path, including one later deleted, blocks', async () => {
    const r = gateRepo();
    r.commit({ 'src/a.ts': `// ${DENIED_NAME}\n` });
    await blocks(RULE, r, r.commit({ 'src/a.ts': 'clean\n' }), RULE);
    const p = gateRepo();
    await blocks(RULE, p, p.commit({ [`src/${DENIED_NAME}.ts`]: 'a\n' }), RULE);
  });
  it('an allowed literal is not a hit', async () => {
    const r = gateRepo();
    expect(
      await runPushGates(
        input(r, r.commit({ 'src/a.ts': `x allowed-literal-${DENIED_NAME} y\n` })),
      ),
    ).toEqual([]);
  });
  it('a missing or empty deny list blocks', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' });
    await blocks(RULE, r, tip, RULE, { deny: null });
    const home = join(r.home, 'empty');
    writeLists(home, { deny: '# nothing\n\n' });
    expect(loadDenyList(join(home, 'policy/name-deny.txt'))).toBeNull();
    expect(loadDenyList(join(home, 'policy/does-not-exist'))).toBeNull();
  });
});

describe('H-PUSH-TREE', () => {
  it('a tip tree different from the reviewed tree blocks', async () => {
    const r = gateRepo();
    const reviewed = r.commit({ 'src/a.ts': 'a\n' });
    const tree = sh(r.dir, 'rev-parse', `${reviewed}^{tree}`);
    const moved = r.commit({ 'src/a.ts': 'changed\n' });
    await blocks('H-PUSH-TREE', r, moved, 'H-PUSH-TREE', { reviewedTree: tree });
  });
  it('a frozen value that is not a full SHA blocks', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' });
    await blocks('H-PUSH-TREE', r, 'HEAD', 'H-PUSH-TREE', {
      reviewedTree: sh(r.dir, 'rev-parse', `${tip}^{tree}`),
    });
  });
});

describe('H-PUSH-BRANCH', () => {
  const RULE = 'H-PUSH-BRANCH';
  it('a branch outside the run namespace blocks', async () => {
    const r = gateRepo();
    await blocks(RULE, r, r.commit({ 'src/a.ts': 'a\n' }), RULE, { destination: 'feature/x' });
  });
  it.each(['main', 'master', 'refs/heads/main'])(
    '%s as the push target blocks',
    async (destination) => {
      const r = gateRepo();
      await blocks(RULE, r, r.commit({ 'src/a.ts': 'a\n' }), RULE, {
        destination,
        destinationRule: { prefix: '' },
      });
    },
  );
  it('the base branch as the push target blocks, whatever it is called', async () => {
    const r = gateRepo();
    await blocks(RULE, r, r.commit({ 'src/a.ts': 'a\n' }), RULE, {
      destination: 'trunkish',
      destinationRule: { prefix: '' },
      baseBranch: 'trunkish',
      acceptedBase: r.base,
    });
  });
  it("the build's own rule is exact", async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' });
    expect(
      await runPushGates(
        input(r, tip, { destination: 'build/v0.1', destinationRule: { exact: 'build/v0.1' } }),
      ),
    ).toEqual([]);
    await blocks(RULE, r, tip, RULE, {
      destination: 'build/v0.2',
      destinationRule: { exact: 'build/v0.1' },
    });
  });
});

describe('H-PUSH-REMOTE', () => {
  const RULE = 'H-PUSH-REMOTE';
  it('an unexpected ref on the remote, in the run namespace, blocks', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' });
    execFileSync('git', [
      '-C',
      r.dir,
      'push',
      '-q',
      r.bare,
      `${r.base}:refs/heads/ecp/r1/worker-made`,
    ]);
    await blocks(RULE, r, tip, RULE);
  });
  it('a destination that is not an ancestor blocks, and is never forced', async () => {
    const r = gateRepo();
    const other = r.commit({ 'src/other.ts': 'o\n' });
    execFileSync('git', [
      '-C',
      r.dir,
      'push',
      '-q',
      r.bare,
      `${other}:refs/heads/ecp/r1/integration`,
    ]);
    execFileSync('git', ['-C', r.dir, 'reset', '-q', '--hard', r.base]);
    const tip = r.commit({ 'src/a.ts': 'a\n' });
    await blocks(RULE, r, tip, RULE);
  });
  it('a destination that is an ancestor is fine', async () => {
    const r = gateRepo();
    const first = r.commit({ 'src/a.ts': 'a\n' });
    execFileSync('git', [
      '-C',
      r.dir,
      'push',
      '-q',
      r.bare,
      `${first}:refs/heads/ecp/r1/integration`,
    ]);
    expect(await runPushGates(input(r, r.commit({ 'src/b.ts': 'b\n' })))).toEqual([]);
  });
});

describe('secret patterns that test files might trip', () => {
  it('this repository assembles its fake secret at run time', () => {
    expect(secretPatterns().some((p) => p.re.test(fakeSecret()))).toBe(true);
  });
});
