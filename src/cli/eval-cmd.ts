import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { WorkerAdapter } from '../contracts/index.ts';
import { RealClock } from '../core/real-clock.ts';
import { loadEvalTasks, runEvalTask } from '../eval/runner.ts';
import { renderEvalReport, reportPairs, type TaskScore } from '../eval/scorer.ts';
import { loadPolicy } from '../policy/load.ts';
import { MockAdapter } from '../workers/mock/mock-adapter.ts';
import { RealMockWorld } from '../workers/mock/real-world.ts';
import { makeRelayAdapters } from '../workers/relay/adapter.ts';
import { ecpHome, loadMockScript, repoRoot } from './wire.ts';

export async function evalCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      rung: { type: 'string' },
      task: { type: 'string' },
      repetitions: { type: 'string' },
      policy: { type: 'string' },
      'mock-script': { type: 'string' },
    },
  });
  const stop = (message: string, code: number) => {
    process.stderr.write(`${message}\n`);
    process.exitCode = code;
  };
  if (!values.rung) {
    return stop(
      'usage: ecp eval --rung <id> [--task <E01>] [--repetitions <n>] [--policy <dir>] [--mock-script <file>]',
      2,
    );
  }
  const root = repoRoot();
  const evalRoot = join(root, 'eval');
  const policy = loadPolicy(values.policy ?? join(root, 'policy'));
  const tasks = loadEvalTasks(evalRoot).filter((t) => !values.task || t.id === values.task);
  if (tasks.length === 0) return stop(`no such task: ${values.task}`, 2);
  let adapters: Record<string, WorkerAdapter>;
  if (values['mock-script']) {
    const script = loadMockScript(values['mock-script']);
    adapters = {
      mock: new MockAdapter({
        script,
        clock: new RealClock(),
        world: new RealMockWorld(),
        classes: policy.failureClasses,
        defaultPlan: { tasks: [], proposed_risk: 'low', spec_defects: [] },
      }),
    };
  } else adapters = makeRelayAdapters({ policy, repoRoot: root, home: ecpHome() });
  const outRoot = join(ecpHome(), 'eval', new Date().toISOString().replace(/[-:.]/g, ''));
  mkdirSync(outRoot, { recursive: true });
  const scores: TaskScore[] = [];
  try {
    for (const task of tasks) {
      for (let repetition = 1; repetition <= Number(values.repetitions ?? 1); repetition++) {
        const score = await runEvalTask({
          evalRoot,
          task,
          rungId: values.rung,
          policy,
          adapters,
          repetition,
          outRoot,
        });
        scores.push(score);
        appendFileSync(join(outRoot, 'results.jsonl'), `${JSON.stringify(score)}\n`);
      }
    }
  } catch (err) {
    return stop(`refused: ${(err as Error).message}`, 3);
  }
  process.stdout.write(renderEvalReport(reportPairs(scores)));
}
