import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { Engine } from '../../src/core/engine.ts';
import { compileSecretPatterns } from '../../src/gates/secret.ts';
import { canonical, sha256 } from '../../src/ledger/canonical.ts';
import { loadPolicy } from '../../src/policy/load.ts';
import { makePublisher } from '../../src/publish/publisher.ts';
import { makeReal } from './harness.ts';
import { readyAdapter } from './ready-adapter.ts';
import { commitAll, makeRepo, sh, tempDir, writeTree } from './repo.ts';

// Everything here is made up by the test. No real private term or real marker appears anywhere.
export const DENIED_NAME = 'Zorblax';
export const MARKER = 'Not for the public branch, zq-77';
export const FORBIDDEN_NAME = 'SECRET_PLAN.md';
export const fakeSecret = () => ['AKIA', 'Q'.repeat(16)].join('');

export function writeLists(
  home: string,
  o: { deny?: string | null; forbidden?: Record<string, unknown> | null } = {},
) {
  mkdirSync(join(home, 'policy'), { recursive: true });
  if (o.deny !== null)
    writeFileSync(
      join(home, 'policy/name-deny.txt'),
      o.deny ?? `#allow allowed-literal-${DENIED_NAME}\n${DENIED_NAME}\n`,
    );
  if (o.forbidden !== null) {
    writeFileSync(
      join(home, 'policy/publish-forbidden.yaml'),
      stringify(
        o.forbidden ?? {
          schema: 'publish_forbidden.v1',
          names: [FORBIDDEN_NAME],
          dirs: ['private/'],
          hashes: [],
          markers: [MARKER],
        },
      ),
    );
  }
}

export function bareFor(repo: string) {
  const bare = join(tempDir('ecp-bare-'), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(repo, 'push', '-q', bare, 'HEAD:refs/heads/main');
  return bare;
}
export const remoteRef = (bare: string, ref: string): string | null => {
  try {
    return execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '-q', ref], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
};
export const remoteHas = (bare: string, sha: string) => {
  try {
    execFileSync('git', ['-C', bare, 'cat-file', '-e', sha], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// A fake gh on PATH. It only knows pr list and pr create, and logs every call, so any attempt to
// merge, close, edit or approve shows up in the log.
const FAKE_GH = `#!${process.execPath}
const fs = require('fs');
const { execFileSync } = require('child_process');
const dir = process.env.FAKE_GH_DIR;
const statePath = dir + '/state.json';
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.log', args.join(' ') + '\\n');
const flag = (n) => args[args.indexOf(n) + 1];
const state = read();
if (args[0] === 'pr' && args[1] === 'list') {
  if (state.list_fails) { console.error('gh list failed'); process.exit(1); }
  console.log(JSON.stringify(state.prs.filter((p) => p.headRefName === flag('--head'))));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  if (state.create_fails) { console.error('gh create failed'); process.exit(1); }
  const head = flag('--head');
  const sha = execFileSync('git', ['-C', process.env.FAKE_GH_BARE, 'rev-parse', 'refs/heads/' + head], { encoding: 'utf8' }).trim();
  const url = 'https://example.invalid/pr/' + (state.prs.length + 1);
  state.prs.push({ url, isDraft: args.includes('--draft'), state: 'OPEN', baseRefName: flag('--base'), headRefName: head, headRefOid: sha, isCrossRepository: false });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(url);
  process.exit(0);
}
console.error('fake gh refuses: ' + args.join(' '));
process.exit(9);
`;

export function installFakeGh(bare: string, state: Record<string, unknown> = {}) {
  const dir = tempDir('ecp-gh-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ prs: [], ...state }));
  writeFileSync(join(dir, 'calls.log'), '');
  process.env.FAKE_GH_DIR = dir;
  process.env.FAKE_GH_BARE = bare;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return {
    calls: () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean),
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    set: (s: Record<string, unknown>) =>
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ prs: [], ...s })),
  };
}

// A real run with real-review fixtures, on real git, to a local bare repository, with a fake gh.
export function publishRun(
  o: {
    script?: any[];
    lists?: Parameters<typeof writeLists>[1];
    allowed?: string[];
    gh?: Record<string, unknown>;
    spec?: any;
  } = {},
) {
  const sim = makeReal({ script: o.script });
  sim.ports.adapters.mock = readyAdapter(sim.adapter);
  const bare = bareFor(sim.repo);
  writeLists(sim.home, o.lists ?? {});
  sim.spec.publish = {
    repo: 'owner/name',
    remote_url: bare,
    base_branch: 'main',
    base_commit: sim.base,
    visibility_expected: 'public',
    allowed_paths: o.allowed ?? ['src/**'],
  };
  sim.spec.target.repo_path = sim.repo;
  Object.assign(sim.spec, o.spec ?? {});
  // The spec is frozen with the engine, so the engine is built after it's final.
  sim.specSha = sha256(canonical(sim.spec));
  sim.engine = new Engine(
    { runId: 'run1', spec: sim.spec, specSha: sim.specSha, policySha: 'b'.repeat(64) },
    sim.ports,
  );
  const publisher = makePublisher({ home: sim.home, repoRoot: '.', policy: sim.policy });
  sim.ports.publisher = publisher;
  const gh = installFakeGh(bare, o.gh ?? {});
  return { sim, bare, gh, publisher };
}

// A hand-built history, for gate checks: one function, one repository, no engine.
export function gateRepo() {
  const { dir, base } = makeRepo({ 'README.md': 'x\n' });
  const bare = bareFor(dir);
  const home = tempDir('ecp-lists-');
  writeLists(home);
  const commit = (
    files: Record<string, string | null>,
    msg = 'c',
    env: Record<string, string> = {},
  ) => {
    for (const [p, c] of Object.entries(files)) {
      if (c === null) execFileSync('rm', ['-f', join(dir, p)]);
      else writeTree(dir, { [p]: c });
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', msg, '--allow-empty'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@example.invalid',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@example.invalid',
        ...env,
      },
    });
    return sh(dir, 'rev-parse', 'HEAD');
  };
  return { dir, base, bare, home, commit };
}

export const secretPatterns = () => compileSecretPatterns(loadPolicy('policy').secretPatterns);
export { commitAll };
