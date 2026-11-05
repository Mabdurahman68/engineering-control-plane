import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { PolicyBundle } from '../contracts/index.ts';
import type { PublishContext, Publisher } from '../core/ports.ts';
import { compileSecretPatterns } from '../gates/secret.ts';
import { git } from '../worktree/real-git.ts';
import { lsRemote, runPushGates } from './gate.ts';
import { loadDenyList, loadForbidden } from './lists.ts';

const FULL_SHA = /^[0-9a-f]{40}$/;

// The only push this code can make: a full SHA, to a named branch, with no force.
export function pushArgv(url: string, sha: string, destination: string): string[] {
  if (!FULL_SHA.test(sha)) throw new Error(`refusing to push ${sha}: not a full SHA`);
  if (destination.startsWith('+') || sha.startsWith('+'))
    throw new Error('refusing a forced refspec');
  return ['push', url, `${sha}:refs/heads/${destination}`];
}

export const PR_FIELDS = 'url,isDraft,state,baseRefName,headRefName,headRefOid,isCrossRepository';

export function validatePrs(
  prs: any[],
  expected: { base: string; head: string; sha: string },
): { ok: boolean; url: string | null; detail: string } {
  if (prs.length !== 1)
    return { ok: false, url: null, detail: `${prs.length} pull requests for this head` };
  const p = prs[0];
  const wrong: string[] = [];
  if (p.isCrossRepository !== false) wrong.push('from a fork');
  if (p.baseRefName !== expected.base) wrong.push(`base is ${p.baseRefName}`);
  if (p.headRefName !== expected.head) wrong.push(`head is ${p.headRefName}`);
  if (p.headRefOid !== expected.sha) wrong.push(`head SHA is ${p.headRefOid}`);
  if (p.isDraft !== true) wrong.push('not a draft');
  if (p.state !== 'OPEN') wrong.push(`state is ${p.state}`);
  return wrong.length
    ? { ok: false, url: p.url ?? null, detail: wrong.join(', ') }
    : { ok: true, url: p.url, detail: 'ok' };
}

function gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

// The only module that may call git push or gh. It never edits, closes, merges or approves.
export function makePublisher(o: {
  home: string;
  repoRoot: string;
  policy: PolicyBundle;
}): Publisher {
  const secretPatterns = compileSecretPatterns(o.policy.secretPatterns);
  const repoOf = (c: PublishContext) => c.spec.target.repo_path;
  return {
    async freeze(c) {
      const sha = (
        await git(['rev-parse', '--verify', `${c.candidate}^{commit}`], { cwd: repoOf(c) })
      ).stdout.trim();
      return { sha };
    },
    async gates(c, sha) {
      const p = c.spec.publish;
      if (!p)
        return {
          ok: false,
          failures: [{ id: 'H-PUSH-BRANCH', detail: 'no publish block' }],
          results: {},
        };
      const failures = await runPushGates({
        repo: repoOf(c),
        remoteUrl: p.remote_url,
        repoName: p.repo,
        baseBranch: p.base_branch,
        baseCommit: p.base_commit,
        frozen: sha,
        destination: c.destination,
        destinationRule: { prefix: `ecp/${c.runId}/` },
        reviewedTree: c.reviewedTree,
        allowedPaths: p.allowed_paths,
        acceptedBase: c.acceptedBase,
        prTitle: c.prTitle,
        prBody: c.prBody,
        deny: loadDenyList(join(o.home, 'policy', 'name-deny.txt')),
        forbidden: loadForbidden(join(o.home, 'policy', 'publish-forbidden.yaml')),
        secretPatterns,
      });
      const ids = [
        'H-PUSH-SECRET',
        'H-PUSH-NAMES',
        'H-PUSH-FILES',
        'H-PUSH-TREE',
        'H-PUSH-BRANCH',
        'H-PUSH-BASE',
        'H-PUSH-REMOTE',
      ];
      const results = Object.fromEntries(
        ids.map((id) => [id, failures.some((f) => f.id === id) ? 'FAIL' : 'PASS']),
      );
      return { ok: failures.length === 0, failures, results };
    },
    async push(c, sha) {
      const p = c.spec.publish;
      if (!p) return { ok: false, detail: 'no publish block' };
      const r = await git(pushArgv(p.remote_url, sha, c.destination), {
        cwd: repoOf(c),
        okCodes: [0, 1, 128],
      });
      return r.code === 0
        ? { ok: true, detail: 'pushed' }
        : { ok: false, detail: r.stderr.trim().slice(0, 400) };
    },
    async verifyPush(c, sha) {
      const at = await this.remoteAt(c);
      return {
        ok: at === sha,
        detail: at === sha ? 'verified' : `remote is at ${at}`,
        observed: at,
      };
    },
    async remoteAt(c) {
      const p = c.spec.publish;
      if (!p) return null;
      const m = await lsRemote(repoOf(c), p.remote_url, `refs/heads/${c.destination}`);
      return m.get(`refs/heads/${c.destination}`) ?? null;
    },
    async listPrs(c) {
      const p = c.spec.publish;
      if (!p) return { ok: false, prs: [], detail: 'no publish block' };
      const r = await gh([
        'pr',
        'list',
        '--repo',
        p.repo,
        '--head',
        c.destination,
        '--state',
        'all',
        '--json',
        PR_FIELDS,
      ]);
      if (r.code !== 0) return { ok: false, prs: [], detail: r.stderr.trim().slice(0, 300) };
      try {
        return { ok: true, prs: JSON.parse(r.stdout), detail: 'ok' };
      } catch {
        return { ok: false, prs: [], detail: 'gh returned invalid JSON' };
      }
    },
    async openPr(c) {
      const p = c.spec.publish;
      if (!p) return { ok: false, url: null, detail: 'no publish block' };
      const r = await gh([
        'pr',
        'create',
        '--repo',
        p.repo,
        '--draft',
        '--base',
        p.base_branch,
        '--head',
        c.destination,
        '--title',
        c.prTitle,
        '--body',
        c.prBody,
      ]);
      if (r.code !== 0) return { ok: false, url: null, detail: r.stderr.trim().slice(0, 300) };
      return { ok: true, url: r.stdout.trim().split('\n').pop() ?? null, detail: 'opened' };
    },
    validatePr(c, sha, prs) {
      return validatePrs(prs as any[], {
        base: c.spec.publish?.base_branch ?? '',
        head: c.destination,
        sha,
      });
    },
  };
}
