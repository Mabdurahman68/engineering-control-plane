import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/load.ts';
import { execCli, CliRefused } from '../../src/workers/relay/cli.ts';
import { DelegateRelayAdapter } from '../../src/workers/relay/adapter.ts';
import {
  authoriseClis,
  BUILD_ALLOWS_REAL_WORKERS,
  evaluateRealDispatch,
} from '../../src/workers/relay/real-worker-guard.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';
import { FIXTURE_BIN, fakeRequest, fakeWorld } from '../support/fake-cli.ts';
import { events, makeSim, runSim } from '../support/harness.ts';
import { tempDir } from '../support/repo.ts';

const RULE = 'R-REAL-WORKER-GUARD';
const ROOT = resolve('.');
const policy = loadPolicy(resolve('policy'));
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

type Bad = { dir: string; sentinel: string; entry?: string };

// A program that acts on any arguments, --version included. Its first act is to leave a mark.
function wrapperDir(): Bad {
  const dir = tempDir('ecp-wrap-');
  const sentinel = join(dir, 'SENTINEL');
  for (const n of ['codex', 'claude', 'opencode']) {
    const p = join(dir, n);
    writeFileSync(
      p,
      `#!/bin/sh\n# ECP-FAKE-CLI-v1\necho ran >> "${sentinel}"\nexec /usr/bin/true\n`,
    );
    chmodSync(p, 0o755);
  }
  return { dir, sentinel };
}
function modifiedCopy(): Bad {
  const b = wrapperDir();
  // Every name is a byte-for-byte fixture, except that it lives elsewhere, or differs by one line.
  for (const n of ['claude', 'opencode']) copyFileSync(join(FIXTURE_BIN, n), join(b.dir, n));
  copyFileSync(join(FIXTURE_BIN, 'fake-cli-core.mjs'), join(b.dir, 'fake-cli-core.mjs'));
  return b;
}
function symlinkOut(): Bad {
  const b = wrapperDir();
  const links = tempDir('ecp-links-');
  for (const n of ['codex', 'claude', 'opencode']) symlinkSync(join(b.dir, n), join(links, n));
  return { dir: links, sentinel: b.sentinel };
}
function symlinkIntoBin(): Bad {
  // Points at a pinned file, but its launcher would run whatever core sits beside the link.
  const b = wrapperDir();
  const links = tempDir('ecp-links-');
  for (const n of ['codex', 'claude', 'opencode'])
    symlinkSync(join(FIXTURE_BIN, n), join(links, n));
  writeFileSync(
    join(links, 'fake-cli-core.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(b.sentinel)}, 'ran');\n`,
  );
  return { dir: links, sentinel: b.sentinel };
}
const CASES: [string, () => Bad][] = [
  ['a marker-bearing wrapper', wrapperDir],
  ['a fixture copy elsewhere', modifiedCopy],
  ['a symlink leaving the directory', symlinkOut],
  ['a symlink into the directory, from elsewhere', symlinkIntoBin],
];

const adapter = () =>
  new DelegateRelayAdapter({ id: 'codex-relay', kind: 'codex', repoRoot: ROOT, policy });

function refused(b: Bad) {
  assertNotForbidden(RULE, existsSync(b.sentinel), 'an unpinned CLI ran');
  expect(existsSync(b.sentinel)).toBe(false);
}

describe.each(CASES)('%s first on PATH', (_n, make) => {
  it('is refused by the guard, by name', () => {
    const b = make();
    const a = authoriseClis(ROOT, fakeWorld([], { before: [b.dir] }).path);
    assertNotForbidden(RULE, a.allowed, 'the guard allowed it');
    refused(b);
  });
  it('never runs for --version, --help or a login check', () => {
    const b = make();
    const w = fakeWorld([], { before: [b.dir] });
    for (const args of [['--version'], ['--help'], ['login', 'status']]) {
      let thrown: unknown = null;
      try {
        execCli(ROOT, 'codex', args, { PATH: w.path, HOME: w.home });
      } catch (err) {
        thrown = err;
      }
      refused(b);
      expect(thrown).toBeInstanceOf(CliRefused);
    }
    refused(b);
  });
  it('never runs through the adapter probe or dispatch', async () => {
    const b = make();
    const w = fakeWorld([], { before: [b.dir] });
    Object.assign(process.env, w.env);
    const health = await adapter().probe('codex-sol');
    refused(b);
    expect(health.installed).toBe(false);
    const out = await adapter()
      .dispatch(fakeRequest(tempDir('ecp-a-')) as never)
      .catch((err) => err);
    await new Promise((r) => setTimeout(r, 1500));
    refused(b);
    expect(out).toBeInstanceOf(CliRefused);
  });
  it('never runs for doctor, run, resume, eval or replay', () => {
    const b = make();
    const w = fakeWorld([], { before: [b.dir] });
    const c = cliEnv();
    const policyArgs = ['--policy', resolve('policy')];
    c.run(['doctor', ...policyArgs], w.env);
    refused(b);
    const r = c.run(['run', c.specPath, ...policyArgs, '--run-id', 'r1'], w.env);
    expect(r.stdout + r.stderr).not.toContain('MOCK_RUN_COMPLETE');
    refused(b);
    c.run(['resume', 'r1'], w.env);
    refused(b);
    c.run(['eval', '--rung', 'codex-sol', '--task', 'E01', ...policyArgs], w.env);
    c.run(['shadow-replay', 'r1', 'DP-1'], w.env);
    refused(b);
    expect(existsSync(join(w.home, 'fake-cli-calls.log'))).toBe(false);
  }, 120_000);
  it('never runs when a run resumes onto it', () => {
    const b = make();
    const c = cliEnv();
    const fine = fakeWorld();
    const args = ['run', c.specPath, '--policy', resolve('policy'), '--run-id', 'r1'];
    const r = c.run(args, { ...fine.env, ECP_FAILPOINT: 'after_intent_before_spawn@1' });
    expect(r.signal).toBe('SIGKILL');
    const bad = fakeWorld([], { before: [b.dir] });
    const again = c.run(['resume', 'r1'], bad.env);
    expect(again.stdout + again.stderr).not.toContain('MOCK_RUN_COMPLETE');
    refused(b);
    expect(existsSync(join(bad.home, 'fake-cli-calls.log'))).toBe(false);
  }, 120_000);
  it('never runs for a shadow dispatch', async () => {
    const b = make();
    Object.assign(process.env, fakeWorld([], { before: [b.dir] }).env);
    const sim = makeSim({
      shadow: true,
      policy: (p) => {
        p.workers.rungs['fake-relay'] = {
          adapter: 'codex-relay',
          model: 'mock-model-openai',
          auth_mode: 'subscription',
          credential_env: [],
        };
        p.workers.ladders.shadow = ['fake-relay'];
      },
      prep: (s) => {
        s.ports.adapters['codex-relay'] = new DelegateRelayAdapter({
          id: 'codex-relay',
          kind: 'codex',
          repoRoot: ROOT,
          policy,
        });
      },
    });
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    refused(b);
    expect(
      events(sim).filter((e: any) => e.type === 'shadow.intent' && e.data.rung === 'fake-relay'),
    ).toEqual([]);
  }, 60_000);
});

describe('what the guard accepts', () => {
  it('accepts the pinned fixtures, and only on an absolute PATH', () => {
    expect(authoriseClis(ROOT, fakeWorld().path).allowed).toBe(true);
    for (const path of [`:${FIXTURE_BIN}`, `test/fake-cli/bin:${FIXTURE_BIN}`]) {
      assertNotForbidden(
        RULE,
        authoriseClis(ROOT, path).allowed,
        `an unknowable PATH passed: ${path}`,
      );
    }
  });
  it('refuses a real-looking CLI first on PATH, and a missing one', () => {
    const b = wrapperDir();
    assertNotForbidden(RULE, authoriseClis(ROOT, `${b.dir}:${FIXTURE_BIN}`).allowed);
    assertNotForbidden(RULE, authoriseClis(ROOT, '/nonexistent').allowed);
  });
  it('refuses when a pinned file has been modified', () => {
    const root = tempDir('ecp-root-');
    execFileSync('cp', ['-R', join(ROOT, 'test'), root], { stdio: 'ignore' });
    const bin = join(root, 'test/fake-cli/bin');
    writeFileSync(
      join(bin, 'fake-cli-core.mjs'),
      `${readFileSync(join(bin, 'fake-cli-core.mjs'), 'utf8')}\n// edit\n`,
    );
    assertNotForbidden(RULE, authoriseClis(root, `${bin}:/bin`).allowed, 'a modified core passed');
    writeFileSync(join(bin, 'codex'), `${readFileSync(join(bin, 'codex'), 'utf8')}\n# edit\n`);
    assertNotForbidden(
      RULE,
      authoriseClis(root, `${bin}:/bin`).allowed,
      'a modified launcher passed',
    );
  });
});

describe('the real-worker chain', () => {
  const machine = 'm';
  const good = { provenance: 'real_actors', passed: true, machine };
  const release = { machine };
  it('holds the constant false in this build', () => {
    assertNotForbidden(
      RULE,
      BUILD_ALLOWS_REAL_WORKERS as boolean,
      'this build allows real workers',
    );
    expect(
      evaluateRealDispatch({
        proof: good,
        release,
        machine,
        buildAllows: BUILD_ALLOWS_REAL_WORKERS,
      }).allowed,
    ).toBe(false);
  });
  it.each([
    ['no proof', { proof: null }],
    ['a fake-actor proof', { proof: { ...good, provenance: 'fake_actors' } }],
    ['a failed proof', { proof: { ...good, passed: false } }],
    ['another machine', { proof: { ...good, machine: 'other' } }],
    ['no release', { release: null }],
  ])('refuses %s, even with the constant true', (_n, over) => {
    assertNotForbidden(
      RULE,
      evaluateRealDispatch({ proof: good, release, machine, buildAllows: true, ...over } as never)
        .allowed,
    );
  });
  it('passes only when every link holds', () => {
    expect(evaluateRealDispatch({ proof: good, release, machine, buildAllows: true }).allowed).toBe(
      true,
    );
  });
});

describe('the only way to a coding CLI', () => {
  it('no source file names one in a spawn, and only the relay module spawns relays', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const f of walk('src')) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(
        /(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`](codex|claude|opencode)\b/,
      );
      if (!f.startsWith('src/workers/relay/')) expect(text, f).not.toContain('relay.mjs');
    }
    const cli = readFileSync('src/workers/relay/cli.ts', 'utf8');
    expect(cli.indexOf('authoriseClis(repoRoot')).toBeLessThan(cli.indexOf('spawnSync(auth'));
  });
});
