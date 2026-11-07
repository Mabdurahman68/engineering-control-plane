import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotForbidden } from '../support/assert.ts';
import { makeReal, runReal } from '../support/harness.ts';

const RULE = 'R-C5-ORPHAN';

describe('a writer that survives its attempt', () => {
  it('writes only to the abandoned worktree', async () => {
    const sim = makeReal({
      script: [
        {
          match: { task: 'T1', step: 'work' },
          behaviour: 'relay_lost',
          edits: [{ path: 'src/t1/partial.txt', content: 'partial\n' }],
          times: 1,
        },
      ],
    });
    // A surviving child: once the next attempt starts, it writes where it always did.
    const dispatch = sim.adapter.dispatch.bind(sim.adapter);
    let oldCwd: string | null = null;
    let wrote = false;
    sim.adapter.dispatch = async (req) => {
      if (req.meta?.task_id === 'T1' && req.meta.step === 'work') {
        if (oldCwd === null) oldCwd = req.cwd;
        else if (!wrote) {
          wrote = true;
          mkdirSync(join(oldCwd, 'src/t1'), { recursive: true });
          writeFileSync(join(oldCwd, 'src/t1/orphan.txt'), 'orphan\n');
        }
      }
      return dispatch(req);
    };
    expect((await runReal(sim)).state).toBe('MOCK_RUN_COMPLETE');
    const t1 = sim.engine.s.tasks.T1;
    expect(wrote).toBe(true);
    const leaked = await sim.git.readFile(t1.commit as string, 'src/t1/orphan.txt');
    assertNotForbidden(RULE, leaked !== null, 'an orphan changed the live tree');
    expect(await sim.git.readFile(t1.commit as string, 'src/t1/partial.txt')).toBeNull();
    const salvaged = sim.store.read(`salvage/T1-1.patch`);
    expect(salvaged).toContain('partial.txt');
  });
});
