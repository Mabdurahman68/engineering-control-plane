import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coordinatorAlive, takeLock } from '../../src/cli/wire.ts';
import { tempDir } from '../support/repo.ts';

describe('the coordinator lock', () => {
  it('a second taker fails while the first is alive', () => {
    const lock = join(tempDir('ecp-lock-'), 'run.lock');
    expect(takeLock(lock)).toBe(true);
    expect(takeLock(lock)).toBe(false);
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
  });
  it('a stale lock is taken over, and a corrupt one too', () => {
    const lock = join(tempDir('ecp-lock-'), 'run.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999_999, start: 'long ago' }));
    expect(coordinatorAlive(lock)).toBe(false);
    expect(takeLock(lock)).toBe(true);
    const other = join(tempDir('ecp-lock-'), 'run.lock');
    writeFileSync(other, 'not json');
    expect(takeLock(other)).toBe(true);
    expect(existsSync(`${other}.${process.pid}.stale`)).toBe(false);
  });
  it('of many processes starting together over a stale lock, exactly one wins', async () => {
    const script = `import { takeLock } from ${JSON.stringify(join(process.cwd(), 'src/cli/wire.ts'))};
      const won = takeLock(process.argv[2]);
      console.log(won ? 'won' : 'lost');
      setTimeout(() => {}, 1500);`;
    const file = join(tempDir('ecp-lock-'), 'take.mts');
    writeFileSync(file, script);
    for (let round = 0; round < 3; round++) {
      const lock = join(tempDir('ecp-lock-'), 'run.lock');
      writeFileSync(lock, JSON.stringify({ pid: 999_999, start: 'long ago' }));
      const results = await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            new Promise<string>((res) => {
              const c = spawn(process.execPath, [file, lock], {
                stdio: ['ignore', 'pipe', 'ignore'],
              });
              let out = '';
              c.stdout.on('data', (d) => (out += d));
              c.on('close', () => res(out.trim()));
            }),
        ),
      );
      expect(results.filter((r) => r === 'won')).toHaveLength(1);
    }
  }, 120_000);
});
