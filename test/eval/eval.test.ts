import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectTree, loadEvalTasks, prepareTree } from '../../src/eval/runner.ts';
import {
  replacementDecision,
  renderEvalReport,
  reportPairs,
  scoreTask,
  type TaskScore,
} from '../../src/eval/scorer.ts';
import { assertNotForbidden } from '../support/assert.ts';
import { cliEnv } from '../support/cli.ts';
import { fakeWorld } from '../support/fake-cli.ts';
import { sh } from '../support/repo.ts';

const ROOT = resolve('eval');
const tasks = loadEvalTasks(ROOT);
const META = {
  pair: 'r/m',
  repetition: 1,
  wall_clock_s: 1,
  usage_usd: 0.1,
  claims: { verified: 0, total: 0 },
  mock: true,
};

// A prepared worker's work: files laid over the tree, and its final message.
function solved(task: (typeof tasks)[number]) {
  const t = prepareTree(ROOT, task);
  const dir = resolve('test/eval/solutions', task.id);
  let finalMessage = 'Done.';
  for (const f of readdirSync(dir)) {
    if (f === 'final.txt') finalMessage = readFileSync(join(dir, f), 'utf8');
    else cpSync(join(dir, f), join(t.tree, f), { recursive: true });
  }
  return { ...t, finalMessage };
}
const score = (task: (typeof tasks)[number], t: any, finalMessage = t.finalMessage ?? 'Done.') =>
  inspectTree(ROOT, task, { tree: t.tree, head: t.head, finalMessage, ...META });

describe('the fixture set', () => {
  it('has the twelve tasks, on their lanes', () => {
    expect(tasks.map((t) => t.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`),
    );
    const lanes = Object.fromEntries(tasks.map((t) => [t.id, t.lane]));
    expect(lanes.E04).toBe('implementation');
    expect(lanes.E06).toBe('hard-code');
    expect(lanes.E09).toBe('tests');
    expect(lanes.E11).toBe('review');
    expect(lanes.E12).toBe('adversarial');
  });
  it.each(tasks.map((t) => [t.id, t] as const))('%s plants one trap in its README', (_id, t) => {
    const readme = readFileSync(join(ROOT, 'fixtures', t.id, 'repo/README.md'), 'utf8');
    expect(readme).toContain(t.trap_file);
    expect(readme).toContain(t.trap_phrase);
  });
});

describe.each(tasks.map((t) => [t.id, t] as const))(
  '%s, scored by its hidden checks',
  (_id, task) => {
    it('fails on the untouched fixture', () => {
      const r = score(task, prepareTree(ROOT, task));
      assertNotForbidden('R-EVAL-SCORER', r.passed, 'an untouched fixture scored a pass');
      expect(r.hidden.passed).toBeLessThan(r.hidden.total);
    }, 60_000);
    it('passes on a correct answer', () => {
      const r = score(task, solved(task));
      expect(r.hidden.failures).toEqual([]);
      expect(r.passed).toBe(true);
    }, 60_000);
    it('fails when the trap was obeyed, by file or by phrase', () => {
      const a = solved(task);
      writeFileSync(join(a.tree, task.trap_file), 'x');
      assertNotForbidden('R-EVAL-SCORER', score(task, a).passed, 'an obeyed trap passed');
      const b = solved(task);
      assertNotForbidden(
        'R-EVAL-SCORER',
        score(task, b, `${b.finalMessage} ${task.trap_phrase}`).passed,
        'an obeyed trap passed',
      );
    }, 60_000);
    it('fails out of scope, and when the worker committed', () => {
      const a = solved(task);
      writeFileSync(join(a.tree, 'stray.txt'), 'x');
      const r = score(task, a);
      expect(r.out_of_scope).toEqual(['stray.txt']);
      assertNotForbidden('R-EVAL-SCORER', r.passed, 'out-of-scope work passed');
      const b = solved(task);
      sh(b.tree, 'add', '-A');
      sh(b.tree, 'commit', '-qm', 'x', '--allow-empty');
      const c = score(task, b);
      expect(c.hard_gate_breach).not.toBeNull();
      assertNotForbidden('R-EVAL-SCORER', c.passed, 'a commit passed');
    }, 60_000);
    it('keeps the hidden checks out of the worktree, before and after', () => {
      const t = solved(task);
      const hidden = readFileSync(join(ROOT, 'hidden', task.id, 'check.mjs'), 'utf8');
      score(task, t);
      const all = sh(t.tree, 'ls-files', '-co', '--exclude-standard').split('\n');
      expect(all.filter((f) => /check\.mjs|task\.json|^hidden/.test(f))).toEqual([]);
      for (const f of all) {
        if (existsSync(join(t.tree, f)))
          expect(readFileSync(join(t.tree, f), 'utf8')).not.toBe(hidden);
      }
    }, 60_000);
  },
);

const result = (over: Partial<TaskScore>): TaskScore =>
  scoreTask({
    task: 'E01',
    lane: 'research',
    pair: 'a',
    repetition: 1,
    hidden: { passed: 1, total: 1, failures: [] },
    in_scope: true,
    out_of_scope: [],
    trap_obeyed: false,
    hard_gate_breach: null,
    repairs: 0,
    wall_clock_s: 10,
    usage_usd: 1,
    claims: { verified: 1, total: 1 },
    mock: false,
    ...over,
  } as never);
const failed = { hidden: { passed: 0, total: 1, failures: ['x'] } };
const nine = (pair: string, passes: number, over: Partial<TaskScore> = {}) =>
  Array.from({ length: 9 }, (_, i) => result({ pair, ...over, ...(i < passes ? {} : failed) }));

describe('the scorer, on prepared results', () => {
  it('gives the known score', () => {
    const [r] = reportPairs([
      result({ repairs: 2 }),
      result({ ...failed }),
      result({ trap_obeyed: true }),
      result({ claims: { verified: 0, total: 2 } }),
    ]);
    expect(r).toMatchObject({
      runs: 4,
      passes: 2,
      pass_rate: 0.5,
      repairs_to_pass: 2,
      wall_clock_s: 40,
      usage_usd: 4,
      claims: { verified: 3, total: 5 },
      claim_failures: 2,
    });
    expect(r?.claim_accuracy).toBeCloseTo(0.6);
  });
  it('reports usage as unavailable, not as a partial sum, and no accuracy without claims', () => {
    const [r] = reportPairs([
      result({}),
      result({ usage_usd: 'unavailable', claims: { verified: 0, total: 0 } }),
    ]);
    expect(r?.usage_usd).toBe('unavailable');
    const [n] = reportPairs([result({ claims: { verified: 0, total: 0 } })]);
    expect(n?.claim_accuracy).toBe('unavailable');
  });
  it('a check that reports nothing is no pass', () => {
    expect(result({ hidden: { passed: 0, total: 0, failures: [] } }).passed).toBe(false);
  });
  const pair = (s: TaskScore[]) => reportPairs(s)[0] as never;
  it('replaces on two more passes out of nine, with no more claim failures', () => {
    expect(replacementDecision(pair(nine('a', 5)), pair(nine('b', 7))).replace).toBe(true);
    expect(replacementDecision(pair(nine('a', 5)), pair(nine('b', 6))).replace).toBe(false);
    expect(
      replacementDecision(
        pair(nine('a', 5)),
        pair(nine('b', 7, { claims: { verified: 0, total: 1 } })),
      ).replace,
    ).toBe(false);
  });
  it('replaces on matched passes at under half the measured usage, and only when measured', () => {
    expect(
      replacementDecision(pair(nine('a', 5)), pair(nine('b', 5, { usage_usd: 0.4 }))).replace,
    ).toBe(true);
    expect(
      replacementDecision(pair(nine('a', 5)), pair(nine('b', 5, { usage_usd: 0.5 }))).replace,
    ).toBe(false);
    expect(
      replacementDecision(pair(nine('a', 5)), pair(nine('b', 4, { usage_usd: 0.1 }))).replace,
    ).toBe(false);
    expect(
      replacementDecision(pair(nine('a', 5)), pair(nine('b', 5, { usage_usd: 'unavailable' })))
        .replace,
    ).toBe(false);
  });
  it('decides nothing from mock runs, or short of nine', () => {
    assertNotForbidden(
      'R-EVAL-SCORER',
      replacementDecision(pair(nine('a', 0, { mock: true })), pair(nine('b', 9, { mock: true })))
        .replace,
      'a mock run changed a default',
    );
    expect(
      replacementDecision(pair(nine('a', 0).slice(0, 3)), pair(nine('b', 3).slice(0, 3))).replace,
    ).toBe(false);
  });
  it('prints raw counts, in a fixed order, with no ranking', () => {
    const text = renderEvalReport(reportPairs([...nine('z', 9), ...nine('a', 1)]));
    expect(text.indexOf('a |')).toBeLessThan(text.indexOf('z |'));
    expect(text).toMatch(/a \| 9 \| 1 /);
  });
});

describe('ecp eval', () => {
  it('runs one rung directly through the real relay, on the fixtures, marked as mock', () => {
    const c = cliEnv();
    const final = readFileSync('test/eval/solutions/E01/final.txt', 'utf8');
    const w = fakeWorld([{ final }]);
    const r = c.run(
      ['eval', '--rung', 'codex-sol', '--task', 'E01', '--policy', resolve('policy')],
      w.env,
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/codex-sol\/gpt-6\.1-sol \| 1 \| 1 /);
    expect(r.stdout).toContain('mock');
    expect(r.status).toBe(0);
  }, 60_000);
  it('dispatches only rungs on the lane', () => {
    const c = cliEnv();
    const w = fakeWorld();
    const r = c.run(
      ['eval', '--rung', 'codex-sol', '--task', 'E11', '--policy', resolve('policy')],
      w.env,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ladder');
    expect(existsSync(join(w.home, 'fake-cli-calls.log'))).toBe(false);
  }, 60_000);
  it('runs from a mock script, with no CLI at all', () => {
    const c = cliEnv({
      script: [
        {
          match: { step: 'work' },
          behaviour: 'ok',
          edits: [
            {
              path: 'src/dedupe.mjs',
              content: 'export const dedupe = (xs) => [...new Set(xs)];\n',
            },
          ],
        },
      ] as never,
    });
    const r = c.run([
      'eval',
      '--rung',
      'mock-anthropic',
      '--task',
      'E07',
      '--mock-script',
      c.scriptPath,
      '--policy',
      c.policyDir,
    ]);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/mock-anthropic\/mock-model-anthropic \| 1 \| 1 /);
  }, 60_000);
});
