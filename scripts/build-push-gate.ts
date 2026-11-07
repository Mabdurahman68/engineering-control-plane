// The build's own push gate, on one frozen commit. It reports; it doesn't push.
// Usage: pnpm push-gate <full-sha> <reviewed-tree>
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compileSecretPatterns } from '../src/gates/secret.ts';
import { loadPolicy } from '../src/policy/load.ts';
import { runPushGates } from '../src/publish/gate.ts';
import { loadDenyList, loadForbidden } from '../src/publish/lists.ts';

const BASE = '8a10cb7f9a5462c33609b7991598321a405b72a9';
const ORIGIN = 'https://github.com/Mabdurahman68/engineering-control-plane';
const ALLOWED = [
  'src/**',
  'policy/**',
  'vendor/delegate-skills/**',
  'eval/**',
  'test/**',
  'prompts/**',
  'docs/**',
  'scripts/**',
  '.github/workflows/ci.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'biome.json',
  'vitest.config.ts',
  '.gitignore',
  '.npmrc',
];

const [frozen, reviewedTree, prTitle = '', prBodyFile] = process.argv.slice(2);
if (!frozen || !reviewedTree) {
  console.error('usage: push-gate <full-sha> <reviewed-tree> [pr-title] [pr-body-file]');
  process.exit(2);
}
const policyDir = join(homedir(), '.ecp', 'policy');
const prBody = prBodyFile ? execFileSync('cat', [prBodyFile], { encoding: 'utf8' }) : '';
const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
if (origin !== ORIGIN) {
  console.error(`origin is ${origin}, not the expected repository`);
  process.exit(1);
}
const failures = await runPushGates({
  repo: process.cwd(),
  remoteUrl: origin,
  repoName: ORIGIN.replace('https://github.com/', ''),
  baseBranch: 'main',
  baseCommit: BASE,
  frozen,
  destination: 'build/v0.1',
  destinationRule: { exact: 'build/v0.1' },
  reviewedTree,
  allowedPaths: ALLOWED,
  acceptedBase: null,
  prTitle,
  prBody,
  deny: loadDenyList(join(policyDir, 'name-deny.txt')),
  forbidden: loadForbidden(join(policyDir, 'publish-forbidden.yaml')),
  secretPatterns: compileSecretPatterns(loadPolicy('policy').secretPatterns),
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
for (const id of ids) console.log(`${failures.some((f) => f.id === id) ? 'FAIL' : 'PASS'} ${id}`);
for (const f of failures) console.log(`  ${f.id}: ${f.detail}`);
process.exit(failures.length ? 1 : 0);
