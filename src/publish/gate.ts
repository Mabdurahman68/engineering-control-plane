import { basename } from 'node:path';
import type { PublishForbidden } from '../contracts/index.ts';
import { matchesAny } from '../gates/glob.ts';
import { scanText } from '../gates/secret.ts';
import { git } from '../worktree/real-git.ts';
import { commitMeta, enumerateRange, readBlob } from './history.ts';
import type { DenyList } from './lists.ts';
import { scanForNames } from './lists.ts';

export type GateFailure = { id: string; detail: string };
export type PushGateInput = {
  repo: string;
  remoteUrl: string;
  repoName: string;
  baseBranch: string;
  baseCommit: string;
  frozen: string;
  destination: string;
  // Exact, for the build's own push; a prefix, for a run's namespace.
  destinationRule: { exact: string } | { prefix: string };
  reviewedTree: string;
  allowedPaths: string[];
  acceptedBase: string | null;
  prTitle: string;
  prBody: string;
  deny: DenyList | null;
  forbidden: PublishForbidden | null;
  secretPatterns: { id: string; re: RegExp }[];
};

const FULL_SHA = /^[0-9a-f]{40}$/;
const NEVER_PUSHED_TO = ['main', 'master', 'trunk', 'develop', 'production', 'release'];

export function checkBranch(
  i: Pick<PushGateInput, 'destination' | 'destinationRule' | 'baseBranch'>,
): GateFailure | null {
  const d = i.destination;
  if (d === i.baseBranch || NEVER_PUSHED_TO.includes(d) || d.startsWith('refs/'))
    return { id: 'H-PUSH-BRANCH', detail: `refusing destination ${d}` };
  if ('exact' in i.destinationRule) {
    if (d !== i.destinationRule.exact)
      return { id: 'H-PUSH-BRANCH', detail: `${d} isn't ${i.destinationRule.exact}` };
  } else if (!d.startsWith(i.destinationRule.prefix)) {
    return { id: 'H-PUSH-BRANCH', detail: `${d} is outside ${i.destinationRule.prefix}` };
  }
  return null;
}

export async function lsRemote(
  repo: string,
  url: string,
  ref?: string,
): Promise<Map<string, string>> {
  const args = ['ls-remote', url, ...(ref ? [ref] : [])];
  const out = (await git(args, { cwd: repo })).stdout;
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t');
    if (sha && name) m.set(name, sha);
  }
  return m;
}

async function isAncestor(repo: string, a: string, b: string): Promise<boolean | null> {
  const known = await git(['cat-file', '-e', `${a}^{commit}`], { cwd: repo, okCodes: [0, 1, 128] });
  if (known.code !== 0) return null;
  return (
    (await git(['merge-base', '--is-ancestor', a, b], { cwd: repo, okCodes: [0, 1] })).code === 0
  );
}

// Everything reads the one frozen SHA, and the range from the base to it.
export async function runPushGates(i: PushGateInput): Promise<GateFailure[]> {
  const failures: GateFailure[] = [];
  const fail = (id: string, detail: string) => failures.push({ id, detail });
  if (!FULL_SHA.test(i.frozen)) fail('H-PUSH-TREE', `frozen commit isn't a full SHA: ${i.frozen}`);

  // H-PUSH-BRANCH
  const branch = checkBranch(i);
  if (branch) failures.push(branch);

  // H-PUSH-TREE
  const tree = (await git(['rev-parse', `${i.frozen}^{tree}`], { cwd: i.repo })).stdout.trim();
  if (tree !== i.reviewedTree)
    fail('H-PUSH-TREE', `frozen tree ${tree} isn't the reviewed tree ${i.reviewedTree}`);

  // The range. Secret, name and file rules all read this one enumeration.
  const { commits, pairs } = await enumerateRange(i.repo, i.baseCommit, i.frozen);
  const meta = await commitMeta(i.repo, commits);
  const blobs = new Map<string, { text: string; sha256: string }>();
  for (const p of pairs) if (!blobs.has(p.blob)) blobs.set(p.blob, await readBlob(i.repo, p.blob));

  // H-PUSH-SECRET: every blob, every commit's message and author fields, the PR title and body.
  const secretOf = (name: string, text: string) => {
    for (const h of scanText(text, i.secretPatterns))
      fail('H-PUSH-SECRET', `${name}:${h.line} (${h.pattern})`);
  };
  for (const p of pairs) secretOf(p.path, (blobs.get(p.blob) as { text: string }).text);
  for (const m of meta) {
    secretOf(`commit ${m.sha} message`, m.message);
    secretOf(
      `commit ${m.sha} author`,
      `${m.author} ${m.authorEmail} ${m.committer} ${m.committerEmail}`,
    );
  }
  secretOf('PR title', i.prTitle);
  secretOf('PR body', i.prBody);

  // H-PUSH-NAMES: the same content. A missing or empty list fails.
  if (!i.deny) fail('H-PUSH-NAMES', 'deny list is missing or empty');
  else {
    const namesOf = (name: string, text: string) => {
      for (const h of scanForNames(text, i.deny as DenyList)) fail('H-PUSH-NAMES', `${name}: ${h}`);
    };
    for (const p of pairs) {
      namesOf(`path ${p.path}`, p.path);
      namesOf(p.path, (blobs.get(p.blob) as { text: string }).text);
    }
    for (const m of meta) {
      namesOf(`commit ${m.sha} message`, m.message);
      namesOf(
        `commit ${m.sha} author`,
        `${m.author}\n${m.authorEmail}\n${m.committer}\n${m.committerEmail}`,
      );
    }
    namesOf('PR title', i.prTitle);
    namesOf('PR body', i.prBody);
  }

  // H-PUSH-FILES: allowlist per path; forbidden path and content hash; marker strings.
  if (!i.forbidden) fail('H-PUSH-FILES', 'forbidden list is missing or empty');
  for (const p of pairs) {
    if (!matchesAny(i.allowedPaths, p.path))
      fail('H-PUSH-FILES', `${p.path} isn't on the allowlist`);
    if (!i.forbidden) continue;
    const blob = blobs.get(p.blob) as { text: string; sha256: string };
    if (i.forbidden.names.includes(basename(p.path)) || i.forbidden.names.includes(p.path))
      fail('H-PUSH-FILES', `${p.path} is a forbidden name`);
    if (i.forbidden.dirs.some((d) => p.path.startsWith(d) || p.path.includes(`/${d}`)))
      fail('H-PUSH-FILES', `${p.path} is under a forbidden directory`);
    if (i.forbidden.hashes.includes(blob.sha256))
      fail('H-PUSH-FILES', `${p.path} has forbidden content (a renamed copy)`);
    for (const m of i.forbidden.markers)
      if (blob.text.includes(m)) fail('H-PUSH-FILES', `${p.path} carries a marker string`);
  }

  // H-PUSH-BASE: exactly at the base, or at the one commit a recorded acceptance names.
  const remote = await lsRemote(i.repo, i.remoteUrl);
  const observed = remote.get(`refs/heads/${i.baseBranch}`) ?? null;
  if (observed === null || (observed !== i.baseCommit && observed !== i.acceptedBase)) {
    fail('H-PUSH-BASE', `remote ${i.baseBranch} is at ${observed}, wanted ${i.baseCommit}`);
  }
  if (!i.remoteUrl.includes(i.repoName) && !i.remoteUrl.startsWith('/'))
    fail('H-PUSH-BASE', `${i.remoteUrl} isn't ${i.repoName}`);

  // H-PUSH-REMOTE: no ref we didn't make, and never anything needing a force.
  if ('prefix' in i.destinationRule) {
    const namespace = `refs/heads/${i.destinationRule.prefix}`;
    for (const name of remote.keys()) {
      if (name.startsWith(namespace) && name !== `refs/heads/${i.destination}`)
        fail('H-PUSH-REMOTE', `unexpected ref ${name}`);
    }
  }
  const existing = remote.get(`refs/heads/${i.destination}`);
  if (existing && existing !== i.frozen) {
    const ok = await isAncestor(i.repo, existing, i.frozen);
    if (ok !== true)
      fail(
        'H-PUSH-REMOTE',
        `${i.destination} is at ${existing}, not an ancestor of the frozen commit`,
      );
  }
  return failures;
}
