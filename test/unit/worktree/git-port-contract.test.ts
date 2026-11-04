import { describe, expect, it } from 'vitest';
import type { GitPort } from '../../../src/worktree/port.ts';
import { RealGit } from '../../../src/worktree/real-git.ts';
import { makeRepo, tempDir, writeTree } from '../../support/repo.ts';
import { SimGit } from '../../support/sim.ts';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

type Driver = {
  git: GitPort;
  base: string;
  wt: string;
  write(p: string, c: string | null): void;
};

const FILES = { 'a.txt': 'one\n', 'b.txt': 'two\n' };

async function realDriver(): Promise<Driver> {
  const r = makeRepo(FILES);
  const git = new RealGit(r.dir);
  const wt = join(tempDir(), 'wt');
  await git.addWorktree(wt, null, r.base);
  return {
    git,
    base: r.base,
    wt,
    write: (p, c) => (c === null ? rmSync(join(wt, p)) : writeTree(wt, { [p]: c })),
  };
}
async function simDriver(): Promise<Driver> {
  const git = new SimGit(FILES);
  const wt = '/sim/wt';
  await git.addWorktree(wt, null, git.root);
  return { git, base: git.root, wt, write: (p, c) => git.writeFile(wt, p, c) };
}

describe.each([
  ['RealGit', realDriver],
  ['SimGit', simDriver],
])('GitPort contract: %s', (_name, make) => {
  it('an untouched worktree hashes to its commit', async () => {
    const d = await make();
    expect(await d.git.worktreeTree(d.wt)).toBe(await d.git.treeOf(d.base));
    expect(await d.git.worktreeClean(d.wt, d.base)).toBe(true);
  });
  it('a changed worktree does not, and a snapshot captures it without moving HEAD', async () => {
    const d = await make();
    d.write('c.txt', 'new\n');
    const tree = await d.git.worktreeTree(d.wt);
    expect(tree).not.toBe(await d.git.treeOf(d.base));
    const s = await d.git.snapshot(d.wt, 'refs/x/1', d.base, 'm');
    expect(s.tree).toBe(tree);
    expect(await d.git.treeOf(s.commit)).toBe(tree);
    expect(await d.git.resolveRef('refs/x/1')).toBe(s.commit);
    expect(await d.git.worktreeHead(d.wt)).toBe(d.base);
  });
  it('resets content and keeps HEAD', async () => {
    const d = await make();
    d.write('c.txt', 'new\n');
    d.write('a.txt', 'changed\n');
    await d.git.resetWorktree(d.wt, d.base);
    expect(await d.git.worktreeClean(d.wt, d.base)).toBe(true);
    expect(await d.git.worktreeHead(d.wt)).toBe(d.base);
  });
  it('reports added, modified and deleted paths', async () => {
    const d = await make();
    d.write('c.txt', 'new\n');
    d.write('a.txt', 'changed\n');
    d.write('b.txt', null);
    const s = await d.git.snapshot(d.wt, 'refs/x/1', d.base, 'm');
    const changed = await d.git.changedFiles(d.base, s.commit);
    const byPath = Object.fromEntries(changed.map((f) => [f.path, f.status]));
    expect(byPath).toEqual({ 'a.txt': 'M', 'b.txt': 'D', 'c.txt': 'A' });
  });
  it('reads a file and its blob ID at a commit, or absent', async () => {
    const d = await make();
    expect(await d.git.readFile(d.base, 'a.txt')).toBe('one\n');
    expect(await d.git.readFile(d.base, 'none.txt')).toBeNull();
    expect(await d.git.blobId(d.base, 'none.txt')).toBe('absent');
    expect(await d.git.blobId(d.base, 'a.txt')).not.toBe('absent');
  });
  it('merges separate edits cleanly, and reports a same-file conflict', async () => {
    const d = await make();
    d.write('a.txt', 'A\n');
    const a = await d.git.snapshot(d.wt, 'refs/x/a', d.base, 'a');
    await d.git.resetWorktree(d.wt, d.base);
    d.write('b.txt', 'B\n');
    const b = await d.git.snapshot(d.wt, 'refs/x/b', d.base, 'b');
    await d.git.resetWorktree(d.wt, d.base);
    d.write('a.txt', 'OTHER\n');
    const c = await d.git.snapshot(d.wt, 'refs/x/c', d.base, 'c');
    const clean = await d.git.mergeTrees(a.commit, b.commit);
    expect(clean.clean).toBe(true);
    const merged = await d.git.commitTree(clean.tree, [a.commit, b.commit], 'merge');
    expect(await d.git.readFile(merged, 'a.txt')).toBe('A\n');
    expect(await d.git.readFile(merged, 'b.txt')).toBe('B\n');
    const conflict = await d.git.mergeTrees(a.commit, c.commit);
    expect(conflict.clean).toBe(false);
    if (!conflict.clean) {
      expect(conflict.conflicted).toEqual(['a.txt']);
      const held = await d.git.commitTree(conflict.tree, [a.commit], 'markers');
      expect(await d.git.readFile(held, 'a.txt')).toContain('<<<<<<<');
    }
  });
  it('commits a tree with the given parents, identical in tree', async () => {
    const d = await make();
    const t = await d.git.treeOf(d.base);
    const c = await d.git.commitTree(t, [d.base], 'm');
    expect(await d.git.treeOf(c)).toBe(t);
  });
});
