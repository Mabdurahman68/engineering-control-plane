import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChangedFile, GitPort, MergeResult } from './port.ts';

const BASE_ENV = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'ecp',
    GIT_AUTHOR_EMAIL: 'ecp@localhost.invalid',
    GIT_COMMITTER_NAME: 'ecp',
    GIT_COMMITTER_EMAIL: 'ecp@localhost.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  return env;
};

export type GitOut = { code: number; stdout: string; stderr: string };

export function git(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; okCodes?: number[]; input?: string },
): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: opts.cwd,
        env: { ...BASE_ENV(), ...opts.env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        if ((opts.okCodes ?? [0]).includes(code)) resolve({ code, stdout, stderr });
        else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export class RealGit implements GitPort {
  readonly repo: string;
  constructor(repo: string) {
    this.repo = repo;
  }
  private g(args: string[], okCodes?: number[], env?: NodeJS.ProcessEnv) {
    return git(args, { cwd: this.repo, okCodes, env });
  }
  async headCommit() {
    return (await this.g(['rev-parse', 'HEAD'])).stdout.trim();
  }
  async rootCommit() {
    const out = (await this.g(['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim().split('\n');
    return out[out.length - 1];
  }
  async isClean() {
    return (await this.g(['status', '--porcelain'])).stdout.trim() === '';
  }
  async remotes() {
    const out = (await this.g(['remote'])).stdout.trim();
    return out ? out.split('\n') : [];
  }
  async listTracked(commit: string) {
    const out = (await this.g(['ls-tree', '-r', '-z', '--name-only', commit])).stdout;
    return out.split('\0').filter(Boolean);
  }
  async configFingerprint() {
    const common = (await this.g(['rev-parse', '--git-common-dir'])).stdout.trim();
    const dir = common.startsWith('/') ? common : join(this.repo, common);
    const h = createHash('sha256');
    h.update(readFileSync(join(dir, 'config')));
    const hooks = join(dir, 'hooks');
    if (existsSync(hooks)) {
      for (const f of readdirSync(hooks).sort()) {
        h.update(f);
        h.update(readFileSync(join(hooks, f)));
      }
    }
    return h.digest('hex');
  }
  async addWorktree(path: string, branch: string | null, commit: string) {
    mkdirSync(dirname(path), { recursive: true });
    const args = branch
      ? ['worktree', 'add', '-q', '-f', '-B', branch, path, commit]
      : ['worktree', 'add', '-q', '-f', '--detach', path, commit];
    await this.g(args);
  }
  async removeWorktree(path: string) {
    await this.g(['worktree', 'remove', '--force', path], [0, 128]);
    rmSync(path, { recursive: true, force: true });
    await this.g(['worktree', 'prune']);
  }
  async worktreeHead(path: string) {
    return (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  }
  async worktreeTree(path: string) {
    const index = join(tmpdir(), `ecp-index-${randomBytes(8).toString('hex')}`);
    try {
      const env = { GIT_INDEX_FILE: index };
      // Seed with the worktree's tracked paths, so a tracked file matching .gitignore stays tracked.
      // Paths and blobs only, no cached stat data: every file is hashed, so a same-size edit made in
      // the same second can't be missed.
      const tracked = (await git(['ls-files', '--stage', '-z'], { cwd: path })).stdout;
      if (tracked)
        await git(['update-index', '-z', '--index-info'], { cwd: path, env, input: tracked });
      await git(['add', '-A', '.'], { cwd: path, env });
      return (await git(['write-tree'], { cwd: path, env })).stdout.trim();
    } finally {
      rmSync(index, { force: true });
    }
  }
  async worktreeClean(path: string, commit: string) {
    return (await this.worktreeTree(path)) === (await this.treeOf(commit));
  }
  async snapshot(path: string, ref: string, parent: string, message: string) {
    const tree = await this.worktreeTree(path);
    const commit = await this.commitTree(tree, [parent], message);
    await this.updateRef(ref, commit);
    return { commit, tree };
  }
  async resetWorktree(path: string, commit: string) {
    // Content moves to the commit; HEAD stays where it was, so H-NOCOMMIT keeps its one baseline.
    await git(['read-tree', '--reset', '-u', commit], { cwd: path });
    await git(['clean', '-qfd'], { cwd: path });
  }
  async salvage(path: string, commit: string) {
    const tree = await this.worktreeTree(path);
    return (await this.g(['diff', '--binary', commit, tree])).stdout;
  }
  async treeOf(commit: string) {
    return (await this.g(['rev-parse', `${commit}^{tree}`])).stdout.trim();
  }
  async changedFiles(base: string, commit: string): Promise<ChangedFile[]> {
    const status = (
      await this.g(['diff', '--no-renames', '--name-status', '-z', base, commit])
    ).stdout
      .split('\0')
      .filter(Boolean);
    const stat = (await this.g(['diff', '--no-renames', '--numstat', '-z', base, commit])).stdout
      .split('\0')
      .filter(Boolean);
    const counts = new Map<string, [number, number]>();
    for (const line of stat) {
      const [a, r, p] = line.split('\t');
      counts.set(p, [a === '-' ? 0 : Number(a), r === '-' ? 0 : Number(r)]);
    }
    const out: ChangedFile[] = [];
    for (let i = 0; i + 1 < status.length; i += 2) {
      const path = status[i + 1];
      const [added, removed] = counts.get(path) ?? [0, 0];
      out.push({ path, status: status[i], added, removed });
    }
    return out;
  }
  async diffText(base: string, commit: string) {
    return (await this.g(['diff', '--no-renames', base, commit])).stdout;
  }
  async readFile(commit: string, path: string) {
    const r = await this.g(['show', `${commit}:${path}`], [0, 128]);
    return r.code === 0 ? r.stdout : null;
  }
  async blobId(commit: string, path: string) {
    const r = await this.g(['rev-parse', `${commit}:${path}`], [0, 128]);
    return r.code === 0 ? r.stdout.trim() : 'absent';
  }
  async commitTree(tree: string, parents: string[], message: string) {
    const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
    return (await this.g(args)).stdout.trim();
  }
  async updateRef(ref: string, commit: string) {
    await this.g(['update-ref', ref, commit]);
  }
  async resolveRef(ref: string) {
    const r = await this.g(['rev-parse', '--verify', '-q', `${ref}^{commit}`], [0, 1]);
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async mergeTrees(ours: string, theirs: string): Promise<MergeResult> {
    const r = await this.g(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs],
      [0, 1],
    );
    const lines = r.stdout.trim().split('\n');
    const tree = lines[0];
    if (r.code === 0) return { clean: true, tree };
    const conflicted = lines.slice(1).filter(Boolean);
    return { clean: false, tree, conflicted };
  }
}
