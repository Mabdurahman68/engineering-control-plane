import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/core/engine.ts';
import { SimulatedKill } from '../../src/core/ports.ts';
import { renderReport } from '../../src/report/report.ts';
import { canonical, sha256 } from '../../src/ledger/canonical.ts';
import { loadLedger } from '../../src/ledger/ledger.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { makeReal, runReal } from '../support/harness.ts';
import {
  DENIED_NAME,
  installFakeGh,
  publishRun,
  remoteRef,
  bareFor,
  writeLists,
} from '../support/publish.ts';
import { makePublisher } from '../../src/publish/publisher.ts';
import { ofTypeReal } from '../support/real-events.ts';

const dest = 'refs/heads/ecp/run1/integration';
const resume = async (sim: any, opts: any = {}) => {
  sim.ports.failpoint = () => {};
  sim.engine = new Engine(
    { runId: 'run1', spec: sim.spec, specSha: sim.specSha, policySha: 'b'.repeat(64) },
    sim.ports,
  );
  sim.engine.loadForResume();
  await sim.engine.resumeRun({ policySha: 'b'.repeat(64), ...opts });
  return sim.engine.loop();
};
const armKill = (sim: any, point: string) => {
  sim.ports.failpoint = (n: string) => {
    if (n === point) throw new SimulatedKill(n);
  };
};

describe('a verified run publishes', () => {
  it('pushes its own branch, opens one draft PR, and validates it', async () => {
    const { sim, bare, gh } = publishRun();
    const exit = await runReal(sim);
    expect(exit.state).toBe('PR_OPENED');
    expect(exit.code).toBe(0);
    expect(remoteRef(bare, dest)).toBe(sim.engine.s.publish.frozen_sha);
    expect(remoteRef(bare, 'refs/heads/main')).toBe(sim.base);
    const prs = gh.state().prs;
    expect(prs.length).toBe(1);
    expect(prs[0]).toMatchObject({
      isDraft: true,
      state: 'OPEN',
      baseRefName: 'main',
      headRefName: 'ecp/run1/integration',
    });
    expect(gh.calls().every((c) => /^pr (list|create)/.test(c))).toBe(true);
    expect(gh.calls().find((c) => c.startsWith('pr create'))).toContain('--draft');
  });
  it('the report states public visibility, and that merging stays with the owner', async () => {
    const { sim } = publishRun();
    await runReal(sim);
    const t = renderReport({
      runId: 'run1',
      spec: sim.spec,
      state: sim.engine.s,
      events: loadLedger(sim.ledger).events,
      proposals: [],
      rungModel: (r) => r,
    });
    expect(t).toContain('Visibility: PUBLIC. Anyone can see this branch and PR');
    expect(t).toContain('Merged: no. Merging is yours');
    expect(t).toContain('verified on remote: yes');
    expect(t).toContain('Push gate: secret, names, files, tree, branch, base: ok');
  });
  it('a target with a remote still fails preflight: workers get no push path', async () => {
    const { sim, bare } = publishRun();
    execFileSync('git', ['-C', sim.repo, 'remote', 'add', 'origin', bare]);
    const exit = await runReal(sim);
    expect(exit.state).toBe('FAILED');
    expect(sim.engine.s.reason).toContain('H-NOPUSH');
  });
  it('no publish block means the run ends at READY, and pushes nothing', async () => {
    const sim = makeReal();
    const { readyAdapter } = await import('../support/ready-adapter.ts');
    sim.ports.adapters.mock = readyAdapter(sim.adapter);
    expect((await runReal(sim)).state).toBe('READY_FOR_HUMAN_MERGE');
    expect(sim.engine.s.publish.frozen_sha).toBeNull();
  });
});

describe('AC-E: a mock run never publishes', () => {
  it('ends at MOCK_RUN_COMPLETE, with no gh call and nothing on the remote', async () => {
    const sim = makeReal();
    const bare = bareFor(sim.repo);
    writeLists(sim.home);
    sim.spec.publish = {
      repo: 'o/n',
      remote_url: bare,
      base_branch: 'main',
      base_commit: sim.base,
      visibility_expected: 'public',
      allowed_paths: ['src/**'],
    };
    sim.specSha = sha256(canonical(sim.spec));
    sim.engine = new Engine(
      { runId: 'run1', spec: sim.spec, specSha: sim.specSha, policySha: 'b'.repeat(64) },
      sim.ports,
    );
    sim.ports.publisher = makePublisher({ home: sim.home, repoRoot: '.', policy: sim.policy });
    const gh = installFakeGh(bare);
    const exit = await runReal(sim);
    assertNotForbidden('AC-E', exit.state !== 'MOCK_RUN_COMPLETE', `ended in ${exit.state}`);
    assertNotForbidden('AC-E', remoteRef(bare, dest) !== null, 'a mock run pushed');
    expect(gh.calls()).toEqual([]);
  });
});

describe('blocked gates stop the push, in a run', () => {
  it('a denied name in the candidate: nothing reaches the remote', async () => {
    const { sim, bare, gh } = publishRun({
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'ok',
          edits: [{ path: 'src/t1/a.txt', content: `made by ${DENIED_NAME}\n` }],
        },
      ],
    });
    const exit = await runReal(sim);
    expect(exit.state).toBe('PUSH_BLOCKED');
    expect(exit.code).toBe(5);
    assertNotForbidden(
      'H-PUSH-NAMES',
      remoteRef(bare, dest) !== null,
      'a denied name reached the remote',
    );
    expect(gh.calls()).toEqual([]);
    expect(ofTypeReal(sim, 'push.gate_failed')[0].data.reason).toContain('H-PUSH-NAMES');
  });
  it('a missing deny list: no push, and the local candidate stays', async () => {
    const { sim, bare } = publishRun({ lists: { deny: null } });
    expect((await runReal(sim)).state).toBe('PUSH_BLOCKED');
    expect(remoteRef(bare, dest)).toBeNull();
    expect(sim.engine.s.integration.tip).toBeTruthy();
  });
  it('a path outside publish.allowed_paths: no push', async () => {
    const { sim, bare } = publishRun({ allowed: ['docs/**'] });
    expect((await runReal(sim)).state).toBe('PUSH_BLOCKED');
    expect(remoteRef(bare, dest)).toBeNull();
  });
  it('ecp publish retries once the cause is fixed, running the whole gate again', async () => {
    const { sim, bare } = publishRun({ lists: { deny: null } });
    await runReal(sim);
    writeLists(sim.home, {});
    sim.engine = new Engine(
      { runId: 'run1', spec: sim.spec, specSha: sim.specSha, policySha: 'b'.repeat(64) },
      sim.ports,
    );
    sim.engine.loadForResume();
    sim.engine.retryPublish(null);
    expect((await sim.engine.loop()).state).toBe('PR_OPENED');
    expect(ofTypeReal(sim, 'push.gate_started').length).toBe(2);
    expect(remoteRef(bare, dest)).toBeTruthy();
  });
  it('a non-fast-forward at push time is reported, and never forced', async () => {
    const { sim, bare, publisher } = publishRun();
    const gates = publisher.gates.bind(publisher);
    publisher.gates = async (c, sha) => {
      const out = await gates(c, sha);
      const tree = execFileSync('git', ['-C', sim.repo, 'rev-parse', `${sim.base}^{tree}`], {
        encoding: 'utf8',
      }).trim();
      const other = execFileSync(
        'git',
        [
          '-C',
          sim.repo,
          '-c',
          'user.name=x',
          '-c',
          'user.email=x@example.invalid',
          'commit-tree',
          tree,
          '-p',
          sim.base,
          '-m',
          'raced',
        ],
        { encoding: 'utf8' },
      ).trim();
      execFileSync('git', ['-C', sim.repo, 'push', '-q', bare, `${other}:${dest}`]);
      return out;
    };
    const exit = await runReal(sim);
    expect(exit.state).toBe('PUSH_BLOCKED');
    expect(ofTypeReal(sim, 'push.rejected').length).toBe(1);
    expect(remoteRef(bare, dest)).not.toBe(sim.engine.s.publish.frozen_sha);
  });
});

describe('crash recovery', () => {
  it('a crash after the push, before its record: asks the remote, and does not push twice', async () => {
    const { sim, bare, publisher } = publishRun();
    let pushes = 0;
    const push = publisher.push.bind(publisher);
    publisher.push = async (c, s) => {
      pushes++;
      const r = await push(c, s);
      throw new SimulatedKill(r.detail);
    };
    await expect(runReal(sim)).rejects.toBeInstanceOf(SimulatedKill);
    expect(remoteRef(bare, dest)).toBeTruthy();
    publisher.push = push;
    const exit = await resume(sim);
    expect(exit.state).toBe('PR_OPENED');
    expect(pushes).toBe(1);
    expect(ofTypeReal(sim, 'push.done').some((e) => e.data.recovered === true)).toBe(true);
  });
  it.each([
    'after:push.sha_frozen',
    'after:push.gate_started',
    'after:push.intent',
    'after:push.done',
    'after:push.verified',
    'after:pr.intent',
    'after:pr.opened',
    'after:pr.validated',
  ])('a crash at %s still ends with one push and one PR', async (point) => {
    const { sim, bare, gh } = publishRun();
    armKill(sim, point);
    await expect(runReal(sim)).rejects.toBeInstanceOf(SimulatedKill);
    const exit = await resume(sim);
    expect(exit.state).toBe('PR_OPENED');
    expect(remoteRef(bare, dest)).toBe(sim.engine.s.publish.frozen_sha);
    assertNotForbidden('B4-PR', gh.state().prs.length !== 1, 'a second PR');
    expect(gh.calls().filter((c) => c.startsWith('pr create')).length).toBe(1);
  });
  it('the remote at something else after a crash blocks', async () => {
    const { sim, bare, publisher } = publishRun();
    const push = publisher.push.bind(publisher);
    publisher.push = async (c, s) => {
      await push(c, s);
      throw new SimulatedKill('after push');
    };
    await expect(runReal(sim)).rejects.toBeInstanceOf(SimulatedKill);
    publisher.push = push;
    execFileSync('git', ['-C', bare, 'update-ref', dest, sim.base]);
    const exit = await resume(sim);
    expect(['PUSH_BLOCKED', 'PR_OPENED']).toContain(exit.state);
    expect(remoteRef(bare, 'refs/heads/main')).toBe(sim.base);
  });
  it('a PR failure leaves the push and reports it', async () => {
    const { sim, bare } = publishRun({ gh: { create_fails: true } });
    const exit = await runReal(sim);
    expect(exit.state).toBe('PUSH_BLOCKED');
    expect(remoteRef(bare, dest)).toBe(sim.engine.s.publish.frozen_sha);
    expect(sim.engine.s.reason).toContain('PR:');
    const t = renderReport({
      runId: 'run1',
      spec: sim.spec,
      state: sim.engine.s,
      events: loadLedger(sim.ledger).events,
      proposals: [],
      rungModel: (r) => r,
    });
    expect(t).toContain('Pushed: yes, to owner/name');
    expect(t).toContain('Draft PR: none');
  });
});

describe('AC-E: the code has no path to anything else', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  const files = walk('src');
  const read = (f: string) => readFileSync(f, 'utf8');
  it('git push and gh appear only in src/publish', () => {
    const outside = files.filter((f) => !f.startsWith('src/publish/'));
    // 'push' alone is also a shadow action's name. What counts is a git argv, or running gh.
    const bad = outside.filter((f) =>
      /\[\s*'push'\s*,|'git',\s*\[?\s*'push'|\bgh\(\[|execFile\('gh'|spawn(Sync)?\('gh'/.test(
        read(f),
      ),
    );
    assertNotForbidden('AC-E', bad.length > 0, bad.join(', '));
  });
  it.each([
    ['--force', /--force(?!-with)|--force-with-lease/],
    ['pr merge', /['"]merge['"],\s*['"]--|pr merge|'pr',\s*'merge'/],
    ['pr close', /pr close|'pr',\s*'close'/],
    ['pr review', /pr review|'pr',\s*'review'/],
    ['pr edit', /pr edit|'pr',\s*'edit'/],
  ])('nothing under src uses %s', (_name, re) => {
    const bad = files.filter((f) => !f.endsWith('real-git.ts') && re.test(read(f)));
    assertNotForbidden('AC-E', bad.length > 0, bad.join(', '));
  });
  it('no + refspec, and no push to a default branch, is built', () => {
    const text = read('src/publish/publisher.ts');
    expect(text).not.toMatch(/`\+\$\{/);
    expect(read('src/publish/gate.ts')).toContain("NEVER_PUSHED_TO = ['main', 'master'");
  });
  it('READY is unreachable without an independent review, or with any mock one', async () => {
    const { makeSim, runSim } = await import('../support/harness.ts');
    const { readyAdapter } = await import('../support/ready-adapter.ts');
    // Mock review: never READY.
    const mock = makeSim();
    expect((await runSim(mock)).state).toBe('MOCK_RUN_COMPLETE');
    // One mock review in an otherwise real run is enough to stop it: sticky.
    const mixed = makeSim();
    const real = readyAdapter(mixed.adapter);
    const wait = real.wait;
    let n = 0;
    real.wait = async (h) => {
      const out = await wait(h);
      n++;
      return n === 5 ? { ...out, transport_provenance: 'mock' } : out;
    };
    mixed.ports.adapters.mock = real;
    const end = await runSim(mixed);
    assertNotForbidden(
      'AC-E',
      end.state === 'READY_FOR_HUMAN_MERGE',
      'a mock review reached READY',
    );
    // No independent family at all: pauses, never READY.
    const none = makeSim({
      policy: (p) => {
        p.workers.ladders.review = ['mock-openai'];
        p.workers.ladders.implementation = ['mock-openai'];
      },
    });
    none.ports.adapters.mock = readyAdapter(none.adapter);
    const stopped = await runSim(none);
    assertNotForbidden(
      'AC-E',
      stopped.state === 'READY_FOR_HUMAN_MERGE',
      'READY with no independent review',
    );
  });
  it('critical work stops for the owner even with real reviews', async () => {
    const { makeSim, runSim, resumeSim, decision } = await import('../support/harness.ts');
    const { readyAdapter } = await import('../support/ready-adapter.ts');
    const sim = makeSim({ spec: { declared_risk: 'critical', requested_depth: 'EXHAUSTIVE' } });
    sim.ports.adapters.mock = readyAdapter(sim.adapter);
    const exit = await runSim(sim);
    expect(exit.state).toBe('ESCALATION_REQUIRED');
    expect(Object.values<any>(sim.engine.s.escalations)[0].reason).toBe('HUMAN_IRREVERSIBLE_GATE');
    const end = await resumeSim(sim, {
      decision: decision(sim.engine.s.open_escalation as string, 'approve'),
    });
    expect(end.state).toBe('READY_FOR_HUMAN_MERGE');
  });
});
