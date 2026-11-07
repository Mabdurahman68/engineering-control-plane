import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPushGates } from '../../src/publish/gate.ts';
import { enumerateRange } from '../../src/publish/history.ts';
import { loadDenyList, loadForbidden } from '../../src/publish/lists.ts';
import { assertNotForbidden } from '../support/assert.ts';
import {
  fakeSecret,
  FORBIDDEN_NAME,
  gateRepo,
  MARKER,
  secretPatterns,
  writeLists,
} from '../support/publish.ts';
import { sh, tempDir } from '../support/repo.ts';

const RULE = 'B5-HISTORY';
const DOC = 'A prohibited document, with no secret and no denied name in it.\n';

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
    allowedPaths: ['src/**', 'docs/**'],
    acceptedBase: null,
    prTitle: 't',
    prBody: 'b',
    deny: loadDenyList(join(r.home, 'policy/name-deny.txt')),
    forbidden: loadForbidden(join(r.home, 'policy/publish-forbidden.yaml')),
    secretPatterns: secretPatterns(),
    ...over,
  };
}
const filesFail = async (r: ReturnType<typeof gateRepo>, frozen: string, over: any = {}) => {
  // All of them: a gate that's merely been renamed still blocks, and that isn't the forbidden outcome.
  return runPushGates(input(r, frozen, over));
};

describe('forbidden files across history', () => {
  it('a prohibited document, added then deleted, with a clean tip, blocks', async () => {
    const r = gateRepo();
    r.commit({ [`src/${FORBIDDEN_NAME}`]: DOC });
    const tip = r.commit({ [`src/${FORBIDDEN_NAME}`]: null, 'src/a.ts': 'a\n' });
    const fails = await filesFail(r, tip);
    assertNotForbidden(RULE, fails.length === 0, 'a prohibited document passed');
    // Nothing else would catch this one: it has no secret and no denied name.
    const all = await runPushGates(input(r, tip));
    expect(all.every((x) => x.id === 'H-PUSH-FILES')).toBe(true);
  });
  it('a renamed exact copy at an allowed path is blocked by hash', async () => {
    const r = gateRepo();
    const home = join(tempDir(), 'h');
    const hash = createHash('sha256').update(DOC).digest('hex');
    writeLists(home, {
      forbidden: {
        schema: 'publish_forbidden.v1',
        names: [FORBIDDEN_NAME],
        dirs: [],
        hashes: [hash],
        markers: [],
      },
    });
    const tip = r.commit({ 'docs/innocent.md': DOC });
    const fails = await filesFail(r, tip, {
      forbidden: loadForbidden(join(home, 'policy/publish-forbidden.yaml')),
    });
    assertNotForbidden(
      RULE,
      !fails.some((x) => x.detail.includes('renamed copy')),
      'a renamed copy passed',
    );
  });
  it('an edited copy with a marker string is blocked', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'docs/innocent.md': `edited, but still: ${MARKER}\n` });
    const fails = await filesFail(r, tip);
    assertNotForbidden(
      RULE,
      !fails.some((x) => x.detail.includes('marker')),
      'a marked copy passed',
    );
  });
  it('a path outside allowed_paths in any commit is blocked', async () => {
    const r = gateRepo();
    r.commit({ 'elsewhere/x.txt': 'x\n' });
    const tip = r.commit({ 'elsewhere/x.txt': null, 'src/a.ts': 'a\n' });
    const fails = await filesFail(r, tip);
    assertNotForbidden(
      RULE,
      !fails.some((x) => x.detail.includes('allowlist')),
      'an unlisted path passed',
    );
  });
  it('a forbidden directory is blocked', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/private/x.txt': 'x\n' });
    expect((await filesFail(r, tip)).some((x) => x.detail.includes('directory'))).toBe(true);
  });
  it('a missing or unusable forbidden list is blocked', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/a.ts': 'a\n' });
    const fails = await filesFail(r, tip, { forbidden: null });
    assertNotForbidden(RULE, fails.length === 0, 'a missing list passed');
    expect(loadForbidden(join(r.home, 'no-such-list'))).toBeNull();
    const empty = join(tempDir(), 'h');
    writeLists(empty, {
      forbidden: { schema: 'publish_forbidden.v1', names: [], dirs: [], hashes: [], markers: [] },
    });
    expect(loadForbidden(join(empty, 'policy/publish-forbidden.yaml'))).toBeNull();
  });
});

describe('content that appears only in a merge', () => {
  function mergeOnly(content: Record<string, string>) {
    const r = gateRepo();
    const a = r.commit({ 'src/a.ts': 'a\n' });
    sh(r.dir, 'checkout', '-q', '-b', 'side', r.base);
    const b = r.commit({ 'src/b.ts': 'b\n' });
    sh(r.dir, 'checkout', '-q', 'main');
    sh(r.dir, 'reset', '-q', '--hard', a);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
    };
    execFileSync('git', ['merge', '-q', '--no-commit', '--no-ff', b], { cwd: r.dir, env });
    for (const [p, c] of Object.entries(content)) {
      execFileSync('mkdir', ['-p', join(r.dir, p, '..')]);
      execFileSync('tee', [join(r.dir, p)], { input: c, stdio: ['pipe', 'ignore', 'ignore'] });
    }
    execFileSync('git', ['add', '-A'], { cwd: r.dir });
    execFileSync('git', ['commit', '-qm', 'merge, with a resolution of its own'], {
      cwd: r.dir,
      env,
    });
    const merge = sh(r.dir, 'rev-parse', 'HEAD');
    const tip = r.commit(Object.fromEntries(Object.keys(content).map((p) => [p, null])));
    return { r, merge, tip };
  }
  it("a forbidden file present only in a merge's resolved tree, then deleted, blocks", async () => {
    const { r, tip, merge } = mergeOnly({ [`src/${FORBIDDEN_NAME}`]: DOC });
    expect(sh(r.dir, 'log', '-1', '--format=%P', merge).split(' ').length).toBe(2);
    expect(sh(r.dir, 'ls-tree', '-r', '--name-only', tip)).not.toContain(FORBIDDEN_NAME);
    const fails = await filesFail(r, tip);
    assertNotForbidden(
      RULE,
      !fails.some((x) => x.detail.includes(FORBIDDEN_NAME)),
      'merge-only content passed',
    );
  });
  it("a secret present only in a merge's resolved tree, then deleted, blocks", async () => {
    const { r, tip } = mergeOnly({ 'src/s.ts': `k = "${fakeSecret()}"\n` });
    const f = await runPushGates(input(r, tip));
    assertNotForbidden(
      RULE,
      !f.some((x) => x.id === 'H-PUSH-SECRET'),
      'a merge-only secret passed',
    );
  });
  it('the enumeration lists it, and leaves out what the base already has', async () => {
    const { r, tip } = mergeOnly({ 'src/m.ts': 'm\n' });
    const { pairs, commits } = await enumerateRange(r.dir, r.base, tip);
    expect(pairs.map((p) => p.path).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/m.ts']);
    expect(commits.length).toBe(4);
  });
  it('a path with odd characters stays one path', async () => {
    const r = gateRepo();
    const tip = r.commit({ 'src/odd name\twith tab.ts': 'x\n' });
    const { pairs } = await enumerateRange(r.dir, r.base, tip);
    expect(pairs.map((p) => p.path)).toEqual(['src/odd name\twith tab.ts']);
  });
});
