// A separate process that drives the production lock modules, one command per stdin line, answering
// with one JSON line each. Tests use it to hold, stop, kill and replace a real coordinator lock.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fstatSync, statSync, writeFileSync } from 'node:fs';
import { prepareHome, lockPathIn } from '../../src/cli/home.ts';
import { acquireLock, type CoordinatorLock } from '../../src/cli/lock.ts';
import { RealCommandRunner } from '../../src/gates/runner.ts';
import { FsLedgerStore } from '../../src/ledger/ledger.ts';
import { loadPolicy } from '../../src/policy/load.ts';
import { DelegateRelayAdapter } from '../../src/workers/relay/adapter.ts';

const [home] = process.argv.slice(2) as [string];
let lock: CoordinatorLock | null = null;
let failFs = false;
const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ledger = () =>
  new FsLedgerStore(join(home, 'runs', 'held', 'ledger', 'events.jsonl'), {
    guard: () => (lock as CoordinatorLock).assertOwner(),
  });

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(' ');
  try {
    switch (cmd) {
      case 'acquire': {
        const real = prepareHome({ home });
        const fs = {
          fstat: (fd: number) => {
            if (failFs) throw new Error('injected fstat failure');
            return fstatSync(fd);
          },
          stat: (p: string) => statSync(p),
        };
        const r = acquireLock(lockPathIn(real), { fs });
        if (r.ok) {
          lock = r.lock;
          lock.writeMeta('held');
        }
        const ino = statSync(join(real, 'layout')).ino;
        say({
          ok: r.ok,
          held: !r.ok && r.held,
          error: !r.ok && !r.held ? r.error : null,
          layoutIno: ino,
          pid: process.pid,
        });
        return;
      }
      case 'append':
        ledger().appendRaw(`${rest.join(' ') || 'line'}\n`);
        say({ appended: true });
        return;
      case 'fail-fs':
        failFs = true;
        say({ failing: true });
        return;
      case 'release':
        lock?.release();
        say({ released: true });
        return;
      case 'append-after-release':
        try {
          ledger().appendRaw('late\n');
          say({ threw: false });
        } catch (err) {
          say({ threw: true, message: String((err as Error).message) });
        }
        return;
      case 'spawn-gate': {
        // Through the production gate path. The child writes its PID and stays.
        const [pidFile] = rest as [string];
        const body = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
        void new RealCommandRunner().run([process.execPath, '-e', body], {
          cwd: home,
          timeout_s: 600,
        });
        say({ spawned: 'gate' });
        return;
      }
      case 'spawn-relay': {
        // Through the production relay path, to a pinned fake CLI that hangs.
        const [dir] = rest as [string];
        const a = new DelegateRelayAdapter({
          id: 'codex-relay',
          kind: 'codex',
          repoRoot: process.cwd(),
          policy: loadPolicy('policy'),
        });
        const out = join(dir, 'attempt');
        writeFileSync(join(dir, 'brief.txt'), 'Implement the task below.\n');
        const h = await a.dispatch({
          attempt_id: 'A-held',
          brief_path: join(dir, 'brief.txt'),
          cwd: dir,
          out_dir: out,
          model: 'm',
          effort: null,
          mode: 'write',
          timeout_s: 600,
          session_id: null,
          env_allowlist: [],
        } as never);
        say({ spawned: 'relay', pid: h.pid });
        return;
      }
      default:
        say({ unknown: cmd });
    }
  } catch (err) {
    say({ error: String((err as Error).message) });
  }
});
say({ ready: true, pid: process.pid });
