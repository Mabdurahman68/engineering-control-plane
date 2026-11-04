import { sha256 } from '../../src/ledger/canonical.ts';
import type { Clock } from '../../src/core/ports.ts';
import type { MockRun, MockWorld } from '../../src/workers/mock/mock-adapter.ts';
import type {
  ChangedFile,
  CommandResult,
  CommandRunner,
  GitPort,
  MergeResult,
} from '../../src/worktree/port.ts';

const h40 = (s: string) => sha256(s).slice(0, 40);
type Files = Record<string, string>;

function treeHash(files: Files): string {
  const keys = Object.keys(files).sort();
  return h40(keys.map((k) => `${k}\0${files[k]}`).join('\0'));
}

// An in-memory model of the git operations the coordinator uses. Same port as RealGit; a shared
// contract suite checks them against each other.
export class SimGit implements GitPort, MockWorld {
  readonly repo = '/sim/repo';
  readonly trees = new Map<string, Files>();
  readonly commits = new Map<string, { tree: string; parents: string[] }>();
  readonly refs = new Map<string, string>();
  readonly worktrees = new Map<string, { files: Files; head: string }>();
  survivors = new Map<string, MockRun>();
  root: string;
  head: string;
  clean = true;
  remotesList: string[] = [];
  config = 'cfg';
  private counter = 0;
  readBriefFn: (p: string) => string | null = () => null;

  constructor(files: Files = { 'README.md': 'x\n' }) {
    this.root = this.putCommit(files, [], 'root');
    this.head = this.root;
  }
  private putTree(files: Files) {
    const t = treeHash(files);
    if (!this.trees.has(t)) this.trees.set(t, { ...files });
    return t;
  }
  private putCommit(files: Files, parents: string[], msg: string) {
    const tree = this.putTree(files);
    const c = h40(`${tree}|${parents.join(',')}|${msg}|${this.counter++}`);
    this.commits.set(c, { tree, parents });
    return c;
  }
  private filesOf(commit: string): Files {
    const c = this.commits.get(commit);
    if (!c) throw new Error(`no commit ${commit}`);
    return this.trees.get(c.tree) as Files;
  }
  private wt(path: string) {
    const w = this.worktrees.get(path);
    if (!w) throw new Error(`no worktree ${path}`);
    return w;
  }
  async headCommit() {
    return this.head;
  }
  async rootCommit() {
    return this.root;
  }
  async isClean() {
    return this.clean;
  }
  async remotes() {
    return this.remotesList;
  }
  async listTracked(commit: string) {
    return Object.keys(this.filesOf(commit)).sort();
  }
  async configFingerprint() {
    return this.config;
  }
  async addWorktree(path: string, branch: string | null, commit: string) {
    this.worktrees.set(path, { files: { ...this.filesOf(commit) }, head: commit });
    if (branch) this.refs.set(`refs/heads/${branch}`, commit);
  }
  async removeWorktree(path: string) {
    this.worktrees.delete(path);
  }
  async worktreeHead(path: string) {
    return this.wt(path).head;
  }
  async worktreeTree(path: string) {
    return treeHash(this.wt(path).files);
  }
  async worktreeClean(path: string, commit: string) {
    return (await this.worktreeTree(path)) === (await this.treeOf(commit));
  }
  async snapshot(path: string, ref: string, parent: string, message: string) {
    const files = this.wt(path).files;
    const commit = this.putCommit(files, [parent], message);
    this.refs.set(ref, commit);
    return { commit, tree: treeHash(files) };
  }
  async resetWorktree(path: string, commit: string) {
    this.wt(path).files = { ...this.filesOf(commit) };
  }
  async salvage(path: string, commit: string) {
    return JSON.stringify(
      await this.changedFiles(commit, this.putCommit(this.wt(path).files, [commit], 's')),
    );
  }
  async treeOf(commit: string) {
    const c = this.commits.get(commit);
    if (!c) throw new Error(`no commit ${commit}`);
    return c.tree;
  }
  async changedFiles(base: string, commit: string): Promise<ChangedFile[]> {
    const a = this.filesOf(base);
    const b = this.filesOf(commit);
    const out: ChangedFile[] = [];
    for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (a[p] === b[p]) continue;
      const lines = (s?: string) => (s ? s.split('\n').filter(Boolean).length : 0);
      if (a[p] === undefined) out.push({ path: p, status: 'A', added: lines(b[p]), removed: 0 });
      else if (b[p] === undefined)
        out.push({ path: p, status: 'D', added: 0, removed: lines(a[p]) });
      else out.push({ path: p, status: 'M', added: lines(b[p]), removed: lines(a[p]) });
    }
    return out;
  }
  async diffText(base: string, commit: string) {
    const b = this.filesOf(commit);
    return (await this.changedFiles(base, commit))
      .map((f) => `+++ ${f.path}\n${b[f.path] ?? ''}`)
      .join('\n');
  }
  async readFile(commit: string, path: string) {
    return this.filesOf(commit)[path] ?? null;
  }
  async blobId(commit: string, path: string) {
    const c = this.filesOf(commit)[path];
    return c === undefined ? 'absent' : h40(`blob:${c}`);
  }
  async commitTree(tree: string, parents: string[], message: string) {
    if (!this.trees.has(tree)) throw new Error(`no tree ${tree}`);
    const c = h40(`${tree}|${parents.join(',')}|${message}|${this.counter++}`);
    this.commits.set(c, { tree, parents });
    return c;
  }
  async updateRef(ref: string, commit: string) {
    this.refs.set(ref, commit);
  }
  async resolveRef(ref: string) {
    if (this.commits.has(ref)) return ref;
    return this.refs.get(ref) ?? null;
  }
  private mergeBase(a: string, b: string): string {
    const seen = new Set<string>();
    const walk = [a];
    while (walk.length) {
      const c = walk.shift() as string;
      if (seen.has(c)) continue;
      seen.add(c);
      walk.push(...(this.commits.get(c)?.parents ?? []));
    }
    const q = [b];
    const seen2 = new Set<string>();
    while (q.length) {
      const c = q.shift() as string;
      if (seen.has(c)) return c;
      if (seen2.has(c)) continue;
      seen2.add(c);
      q.push(...(this.commits.get(c)?.parents ?? []));
    }
    return this.root;
  }
  async mergeTrees(ours: string, theirs: string): Promise<MergeResult> {
    const base = this.filesOf(this.mergeBase(ours, theirs));
    const a = this.filesOf(ours);
    const b = this.filesOf(theirs);
    const out: Files = {};
    const conflicted: string[] = [];
    for (const p of [
      ...new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)]),
    ].sort()) {
      const [x, y, z] = [base[p], a[p], b[p]];
      if (y === z) {
        if (y !== undefined) out[p] = y;
      } else if (y === x) {
        if (z !== undefined) out[p] = z;
      } else if (z === x) {
        if (y !== undefined) out[p] = y;
      } else {
        conflicted.push(p);
        out[p] =
          `${'<'.repeat(7)} ours\n${y ?? ''}${'='.repeat(7)}\n${z ?? ''}${'>'.repeat(7)} theirs\n`;
      }
    }
    const tree = this.putTree(out);
    return conflicted.length ? { clean: false, tree, conflicted } : { clean: true, tree };
  }

  // MockWorld
  writeFile(cwd: string, path: string, content: string | null) {
    const w = this.wt(cwd);
    if (content === null) delete w.files[path];
    else w.files[path] = content;
  }
  commitHead(cwd: string) {
    const w = this.wt(cwd);
    w.head = this.putCommit(w.files, [w.head], 'worker commit');
  }
  tamperConfig() {
    this.config = 'tampered';
  }
  readFileIn(cwd: string, path: string) {
    return this.wt(cwd).files[path] ?? null;
  }
  readBrief(path: string) {
    return this.readBriefFn(path);
  }
}

// `sim <name>` commands: fail if `.sim/fail/<name>` exists, rewrite a file if `.sim/rewrite` names it.
export class SimRunner implements CommandRunner {
  private readonly git: SimGit;
  calls: { argv: string[]; cwd: string }[] = [];
  constructor(git: SimGit) {
    this.git = git;
  }
  async run(argv: string[], opts: { cwd: string; timeout_s: number }): Promise<CommandResult> {
    this.calls.push({ argv, cwd: opts.cwd });
    const w = this.git.worktrees.get(opts.cwd);
    const name = argv[1] ?? argv[0];
    const files = w?.files ?? {};
    const rewrite = files['.sim/rewrite'];
    if (rewrite && w) w.files[rewrite.trim()] = `rewritten by ${name}\n`;
    const failure = files[`.sim/fail/${name}`];
    if (failure !== undefined)
      return { code: 1, log: failure || `Error: ${name} failed`, duration_ms: 1, timed_out: false };
    return { code: 0, log: `${name} ok`, duration_ms: 1, timed_out: false };
  }
}

// A virtual clock: time moves only when the engine has nothing to do.
export class VirtualClock implements Clock {
  t = Date.UTC(2026, 0, 1);
  private timers: { at: number; fn: () => void; seq: number }[] = [];
  private seq = 0;
  now() {
    return this.t;
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + ms, fn: resolve, seq: this.seq++ });
    });
  }
  advance(ms: number) {
    this.t += ms;
  }
  async idle(
    wakeAt: number | null,
    isNotified: () => boolean,
    subscribe: (fn: () => void) => void,
  ) {
    void subscribe;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
      if (isNotified()) return;
    }
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.timers[0];
    if (next && (wakeAt === null || next.at <= wakeAt)) {
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
        if (isNotified()) return;
      }
      return;
    }
    if (wakeAt !== null) {
      this.t = Math.max(this.t, wakeAt);
      return;
    }
    throw new Error('virtual clock: nothing can ever wake the engine');
  }
}
