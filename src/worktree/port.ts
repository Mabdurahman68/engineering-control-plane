export type ChangedFile = { path: string; status: string; added: number; removed: number };
export type MergeResult =
  | { clean: true; tree: string }
  | { clean: false; tree: string; conflicted: string[] };

// Everything the coordinator does to a repository. Two drivers: real git, and an in-memory model.
export interface GitPort {
  readonly repo: string;
  headCommit(): Promise<string>;
  rootCommit(): Promise<string>;
  isClean(): Promise<boolean>;
  remotes(): Promise<string[]>;
  listTracked(commit: string): Promise<string[]>;
  // Hash of .git/config and hooks, for H-GITCFG.
  configFingerprint(): Promise<string>;
  addWorktree(path: string, branch: string | null, commit: string): Promise<void>;
  removeWorktree(path: string): Promise<void>;
  worktreeHead(path: string): Promise<string>;
  worktreeTree(path: string): Promise<string>;
  worktreeClean(path: string, commit: string): Promise<boolean>;
  snapshot(
    path: string,
    ref: string,
    parent: string,
    message: string,
  ): Promise<{ commit: string; tree: string }>;
  resetWorktree(path: string, commit: string): Promise<void>;
  salvage(path: string, commit: string): Promise<string>;
  treeOf(commit: string): Promise<string>;
  changedFiles(base: string, commit: string): Promise<ChangedFile[]>;
  diffText(base: string, commit: string): Promise<string>;
  readFile(commit: string, path: string): Promise<string | null>;
  blobId(commit: string, path: string): Promise<string>;
  commitTree(tree: string, parents: string[], message: string): Promise<string>;
  updateRef(ref: string, commit: string): Promise<void>;
  resolveRef(ref: string): Promise<string | null>;
  mergeTrees(ours: string, theirs: string): Promise<MergeResult>;
}

export type CommandResult = { code: number; log: string; duration_ms: number; timed_out: boolean };

export interface CommandRunner {
  run(argv: string[], opts: { cwd: string; timeout_s: number }): Promise<CommandResult>;
}

export interface RunStore {
  write(rel: string, content: string): void;
  read(rel: string): string | null;
  exists(rel: string): boolean;
  list(rel: string): string[];
  // Absolute path for things that need a real path; in memory it's a stable fake.
  path(rel: string): string;
}
