import { readLockMeta } from '../../src/cli/lock.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliEnv } from '../support/cli.ts';
import { ledgerEvents, pidAlive, until } from '../support/fake-cli.ts';
import { tempDir } from '../support/repo.ts';

// A required test that records its PID, then runs until a file says otherwise.
function slowGate() {
  const dir = tempDir('ecp-gate-');
  const pids = join(dir, 'pids');
  const go = join(dir, 'go');
  const body = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');if(!fs.existsSync(${JSON.stringify(go)}))setInterval(()=>{},1000);`;
  const c = cliEnv({
    spec: {
      required_tests: [{ id: 'unit', command: [process.execPath, '-e', body], timeout_s: 600 }],
    },
  });
  const held = () =>
    existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  return { c, held, release: () => writeFileSync(go, '') };
}
const lastGateIntent = (home: string) =>
  ledgerEvents(home, 'r1').filter((e) => e.type === 'gate.finished').length;
const cleanup = (pids: number[]) => {
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
};

describe('a real gate subprocess', () => {
  it('cancel stops it promptly, with no orphan and no outcome from that run', async () => {
    const { c, held } = slowGate();
    const run = c.runAsync(c.startArgs('r1'));
    expect(await until(() => held().length > 0, 60_000)).toBe(true);
    const finishedBefore = lastGateIntent(c.home);
    const asked = Date.now();
    c.run(['cancel', 'r1']);
    const end = await run;
    expect(Date.now() - asked).toBeLessThan(30_000);
    expect(end.stdout).toContain('CANCELLED');
    expect(await until(() => held().every((p) => !pidAlive(p)), 5000)).toBe(true);
    expect(lastGateIntent(c.home)).toBe(finishedBefore);
    cleanup(held());
  }, 180_000);
  it('pause stops it too, and resume runs the gate again', async () => {
    const { c, held, release } = slowGate();
    const run = c.runAsync(c.startArgs('r1'));
    expect(await until(() => held().length > 0, 60_000)).toBe(true);
    const finishedBefore = lastGateIntent(c.home);
    c.run(['pause', 'r1']);
    const end = await run;
    expect(end.stdout).toContain('PAUSED');
    expect(held().every((p) => !pidAlive(p))).toBe(true);
    expect(lastGateIntent(c.home)).toBe(finishedBefore);
    const first = held().length;
    release();
    const again = c.run(['resume', 'r1']);
    expect(again.stdout).toContain('MOCK_RUN_COMPLETE');
    expect(held().length).toBeGreaterThan(first);
    cleanup(held());
  }, 240_000);
  it('a coordinator killed mid-gate: resume kills the old command before running it again', async () => {
    const { c, held, release } = slowGate();
    const run = c.runAsync(c.startArgs('r1'));
    expect(await until(() => held().length > 0, 60_000)).toBe(true);
    process.kill(readLockMeta(join(c.home, 'coordinator.lock'))?.pid as number, 'SIGKILL');
    await run;
    const [old] = held() as [number];
    expect(pidAlive(old)).toBe(true);
    release();
    const again = c.run(['resume', 'r1']);
    expect(again.stdout).toContain('MOCK_RUN_COMPLETE');
    expect(pidAlive(old)).toBe(false);
    cleanup(held());
  }, 240_000);
});
