import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fakeActors,
  REQUIRED_ACTORS,
  runIsolationProof,
  SURFACES_FOR,
} from '../../src/isolation/prove.ts';
import { evaluateRealDispatch } from '../../src/workers/relay/real-worker-guard.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';
import { fakeWorld } from '../support/fake-cli.ts';

const RULE = 'R-C7-ISOLATION';
const machine = 'm-1';

describe('the isolation proof, with fake actors', () => {
  it('passes when every attempt is denied, and is marked as fake', () => {
    const p = runIsolationProof({ actors: fakeActors(), machine });
    expect(p.passed).toBe(true);
    expect(p.provenance).toBe('fake_actors');
    expect(p.incomplete).toEqual([]);
  });
  it('covers each actor against each surface the table closes to it', () => {
    const p = runIsolationProof({ actors: fakeActors(), machine });
    const expected = REQUIRED_ACTORS.flatMap((a) =>
      SURFACES_FOR[a.role].flatMap((s) => s.ops.length),
    );
    expect(p.attempts.length).toBe(expected.reduce((x, y) => x + y, 0));
    expect(p.attempts.every((x) => x.result === 'denied')).toBe(true);
  });
  it.each(REQUIRED_ACTORS.map((a) => [a.id] as const))('fails when %s can read a canary', (id) => {
    const actors = fakeActors({ leak: { actor: id, op: 'read' } });
    assertNotForbidden(RULE, runIsolationProof({ actors, machine }).passed, 'a canary was read');
  });
  it('fails when a write gets through', () => {
    const actors = fakeActors({ leak: { actor: 'gate', op: 'write' } });
    assertNotForbidden(RULE, runIsolationProof({ actors, machine }).passed, 'a canary was written');
  });
  it('fails when an escaping child outlives kill-all, or its write lands', () => {
    for (const child of [
      { heartbeat_stopped: false },
      { process_count: 1 },
      { revoked_write_denied: false },
    ]) {
      const actors = fakeActors({ escape: child });
      assertNotForbidden(
        RULE,
        runIsolationProof({ actors, machine }).passed,
        JSON.stringify(child),
      );
    }
  });
  it('fails as incomplete on a missing actor', () => {
    const actors = fakeActors().filter((a) => a.id !== 'codex-read-only');
    const p = runIsolationProof({ actors, machine });
    assertNotForbidden(RULE, p.passed, 'a missing actor passed');
    expect(p.incomplete).toContain('actor codex-read-only');
  });
  it('fails as incomplete on a missing surface', () => {
    const actors = fakeActors({ skip: { actor: 'gate', surface: 'worktree' } });
    const p = runIsolationProof({ actors, machine });
    assertNotForbidden(RULE, p.passed, 'a missing surface passed');
    expect(p.incomplete.join()).toContain('gate: worktree');
  });
  it('treats an attempt that errors as no evidence', () => {
    const actors = fakeActors({ error: { actor: 'gate' } });
    assertNotForbidden(
      RULE,
      runIsolationProof({ actors, machine }).passed,
      'an error counted as denied',
    );
  });
  it('never lets a fake-actor proof authorise a real worker', () => {
    const proof = runIsolationProof({ actors: fakeActors(), machine });
    const r = evaluateRealDispatch({ proof, release: { machine }, machine, buildAllows: true });
    assertNotForbidden(RULE, r.allowed, 'a fake proof authorised a real worker');
  });
});

describe('ecp isolation-prove', () => {
  it('writes its proof outside the repository, marked as fake', () => {
    const c = cliEnv();
    const r = c.run(['isolation-prove']);
    expect(r.status).toBe(0);
    const proof = JSON.parse(readFileSync(join(c.home, 'isolation-proof.json'), 'utf8'));
    expect(proof.provenance).toBe('fake_actors');
    expect(existsSync(resolve('docs/isolation-proof.json'))).toBe(false);
    expect(r.stdout).toContain('fake actors');
  });
  it('leaves ecp run refusing a real rung, proof or no proof', () => {
    const c = cliEnv();
    c.run(['isolation-prove']);
    // No fixtures on this PATH, and so no way to a rung that isn't real.
    const w = fakeWorld();
    const env = { ...w.env, PATH: '/usr/bin:/bin' };
    const r = c.run(['run', c.specPath, '--policy', resolve('policy'), '--run-id', 'r1'], env);
    assertNotForbidden(RULE, r.status === 0, 'a real rung ran');
    expect(r.stderr).toMatch(/refus/i);
    expect(r.stderr).toContain('fake_actors');
  });
});
