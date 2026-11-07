import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: 'pipe' }).trim();
}

export function tempDir(prefix = 'ecp-t-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeTree(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}

// A repo with one commit. Returns the path and the base commit.
export function makeRepo(files: Record<string, string> = { 'README.md': 'x\n' }) {
  const dir = tempDir('ecp-repo-');
  sh(dir, 'init', '-q', '-b', 'main');
  writeTree(dir, files);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'init');
  return { dir, base: sh(dir, 'rev-parse', 'HEAD') };
}

export function commitAll(dir: string, message = 'c') {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', message);
  return sh(dir, 'rev-parse', 'HEAD');
}
