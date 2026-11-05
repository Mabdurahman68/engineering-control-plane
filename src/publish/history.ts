import { createHash } from 'node:crypto';
import { git } from '../worktree/real-git.ts';

export type PathBlob = { path: string; blob: string };
export type CommitMeta = {
  sha: string;
  author: string;
  authorEmail: string;
  committer: string;
  committerEmail: string;
  message: string;
};

// By commit tree, not by diff, so a merge can't hide content. Every commit in base..frozen, merges
// included, listed with NUL separators. A pair identical to one in the base's tree isn't new content.
// Everything else is scanned however it arose: added, renamed, or from a merge resolution, including
// one deleted before the tip.
export async function enumerateRange(
  repo: string,
  base: string,
  frozen: string,
): Promise<{ commits: string[]; pairs: PathBlob[] }> {
  const commits = (await git(['rev-list', `${base}..${frozen}`], { cwd: repo })).stdout
    .split('\n')
    .filter(Boolean);
  const inBase = new Set((await lsTree(repo, base)).map((p) => `${p.blob}\0${p.path}`));
  const seen = new Map<string, PathBlob>();
  for (const c of commits) {
    for (const p of await lsTree(repo, c)) {
      const key = `${p.blob}\0${p.path}`;
      if (!inBase.has(key)) seen.set(key, p);
    }
  }
  return { commits, pairs: [...seen.values()] };
}

async function lsTree(repo: string, commit: string): Promise<PathBlob[]> {
  const out = (await git(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: repo })).stdout;
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, , blob] = line.slice(0, tab).split(' ');
      return { path: line.slice(tab + 1), blob };
    });
}

export async function commitMeta(repo: string, commits: string[]): Promise<CommitMeta[]> {
  const out: CommitMeta[] = [];
  for (const sha of commits) {
    const text = (
      await git(['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha], { cwd: repo })
    ).stdout;
    const [author, authorEmail, committer, committerEmail, message] = text.split('\0');
    out.push({ sha, author, authorEmail, committer, committerEmail, message: message ?? '' });
  }
  return out;
}

export async function readBlob(
  repo: string,
  blob: string,
): Promise<{ text: string; sha256: string }> {
  const { execFile } = await import('node:child_process');
  const buf = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      'git',
      ['cat-file', 'blob', blob],
      { cwd: repo, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  return { text: buf.toString('utf8'), sha256: createHash('sha256').update(buf).digest('hex') };
}
