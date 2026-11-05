#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { decisionSchema } from '../contracts/index.ts';
import { assertMixedFamilies, loadPolicy, policyHash } from '../policy/load.ts';
import { renderMetrics, renderStatus } from '../report/report.ts';
import { verifyRelayPins } from '../workers/relay/pins.ts';
import { replayCommand } from './replay-cmd.ts';
import { evalCommand } from './eval-cmd.ts';
import { isolationCommand } from './isolation-cmd.ts';
import {
  atomicWrite,
  coordinatorAlive,
  ecpHome,
  loadMockScript,
  loadSpecFile,
  readRun,
  repoRoot,
  runDir,
  takeLock,
  wire,
} from './wire.ts';

function fail(message: string, code = 1): never {
  process.stderr.write(`ecp: ${message}\n`);
  process.exit(code);
}

const globalLock = () => join(ecpHome(), 'run.lock');

async function cmdRun(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'mock-script': { type: 'string' },
      policy: { type: 'string' },
      'run-id': { type: 'string' },
    },
  });
  const specPath = positionals[0];
  if (!specPath)
    fail('usage: ecp run <spec.yaml> [--mock-script <file>] [--policy <dir>] [--run-id <id>]', 2);
  const spec = loadSpecFile(specPath);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const runId = values['run-id'] ?? `${spec.spec_id}-${stamp}Z`;
  if (existsSync(join(runDir(runId), 'ledger', 'events.jsonl')))
    fail(`run ${runId} already exists; use ecp resume`);
  if (!takeLock(globalLock())) fail('another run is active: one active run at a time');
  const mockScript = values['mock-script'] ? loadMockScript(values['mock-script']) : null;
  const w = wire({ runId, spec, policyDir: values.policy, mockScript });
  w.store.write('spec.yaml', readFileSync(specPath, 'utf8'));
  w.store.write('policy.lock', JSON.stringify({ sha256: w.policySha }));
  w.store.write(
    'run-config.json',
    JSON.stringify({ policy: values.policy ?? null, mock_script: mockScript }),
  );
  w.engine.createRun();
  const exit = await w.engine.loop();
  rmSync(globalLock(), { force: true });
  process.stdout.write(`${runId} ${exit.state}\n`);
  process.exitCode = exit.code;
}

function loadRunConfig(runId: string) {
  const dir = runDir(runId);
  if (!existsSync(join(dir, 'spec.yaml'))) fail(`no such run: ${runId}`);
  const cfg = JSON.parse(readFileSync(join(dir, 'run-config.json'), 'utf8'));
  return { spec: loadSpecFile(join(dir, 'spec.yaml')), cfg };
}

async function runResume(
  runId: string,
  opts: { decisionFile?: string; accept?: boolean; extend?: number },
) {
  const { spec, cfg } = loadRunConfig(runId);
  if (!takeLock(globalLock())) fail('another run is active');
  const w = wire({ runId, spec, policyDir: cfg.policy ?? undefined, mockScript: cfg.mock_script });
  const locked = JSON.parse(w.store.read('policy.lock') as string).sha256;
  if (locked !== w.policySha && !opts.accept) {
    rmSync(globalLock(), { force: true });
    fail('policy changed since the run started: use --accept-policy-change', 1);
  }
  let decision: Record<string, unknown> | undefined;
  if (opts.decisionFile) {
    const parsed = decisionSchema.safeParse(parse(readFileSync(opts.decisionFile, 'utf8')));
    if (!parsed.success) {
      rmSync(globalLock(), { force: true });
      fail(`invalid decision: ${parsed.error.message}`);
    }
    decision = parsed.data;
  }
  w.engine.loadForResume();
  await w.engine.resumeRun({
    acceptPolicy: opts.accept,
    extendBudget: opts.extend,
    decision,
    policySha: w.policySha,
  });
  if (opts.accept) w.store.write('policy.lock', JSON.stringify({ sha256: w.policySha }));
  const exit = await w.engine.loop();
  rmSync(globalLock(), { force: true });
  process.stdout.write(`${runId} ${exit.state}\n`);
  process.exitCode = exit.code;
}

async function cmdResume(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'with-decision': { type: 'string' },
      'accept-policy-change': { type: 'boolean' },
      'extend-budget': { type: 'string' },
    },
  });
  if (!positionals[0])
    fail(
      'usage: ecp resume <run-id> [--with-decision <file>] [--accept-policy-change] [--extend-budget <n>]',
      2,
    );
  await runResume(positionals[0], {
    decisionFile: values['with-decision'],
    accept: values['accept-policy-change'],
    extend: values['extend-budget'] ? Number(values['extend-budget']) : undefined,
  });
}

async function cmdControl(request: 'pause' | 'cancel', args: string[]) {
  const runId = args[0];
  if (!runId) fail(`usage: ecp ${request} <run-id>`, 2);
  if (!existsSync(runDir(runId))) fail(`no such run: ${runId}`);
  atomicWrite(join(runDir(runId), 'control', 'request.json'), JSON.stringify({ request }));
  // With no coordinator alive, apply it here: take the lock, reconcile, and act.
  if (coordinatorAlive(globalLock())) {
    process.stdout.write(`${request} requested\n`);
    return;
  }
  await runResume(runId, {});
}

function cmdStatus(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { all: { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const runsDir = join(ecpHome(), 'runs');
  const ids =
    values.all || !positionals[0]
      ? existsSync(runsDir)
        ? readdirSync(runsDir).sort()
        : []
      : [positionals[0]];
  if (!values.all && !positionals[0] && ids.length) ids.splice(0, ids.length - 1);
  if (!ids.length) fail('no runs');
  for (const id of ids) {
    const { events, state } = readRun(id);
    const st = renderStatus({ runId: id, state, events, now: Date.now() });
    if (values.json) process.stdout.write(`${JSON.stringify(st.json)}\n`);
    else if (values.all)
      process.stdout.write(
        `${id} ${state.state} risk=${state.risk} tasks=${Object.keys(state.tasks).length}\n`,
      );
    else process.stdout.write(st.text);
  }
}

function cmdReport(args: string[]) {
  const runId = args[0];
  if (!runId) fail('usage: ecp report <run-id>', 2);
  const p = join(runDir(runId), 'RUN_REPORT.md');
  if (!existsSync(p)) fail('no report yet');
  process.stdout.write(readFileSync(p, 'utf8'));
}

async function cmdClean(args: string[]) {
  const runsDir = join(ecpHome(), 'runs');
  const ids = args[0] ? [args[0]] : existsSync(runsDir) ? readdirSync(runsDir) : [];
  for (const id of ids) {
    const { state } = readRun(id);
    if (['ESCALATION_REQUIRED', 'FAILED'].includes(state.state) && !args.includes('--all'))
      continue;
    if (state.state.startsWith('PAUSED_')) continue;
    rmSync(join(ecpHome(), 'worktrees', id), { recursive: true, force: true });
    process.stdout.write(`cleaned ${id}\n`);
  }
}

function cmdMetrics() {
  const runsDir = join(ecpHome(), 'runs');
  const ids = existsSync(runsDir) ? readdirSync(runsDir) : [];
  process.stdout.write(renderMetrics(ids.map((runId) => ({ runId, ...readRun(runId) }))));
}

async function cmdDoctor(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { policy: { type: 'string' }, 'notify-test': { type: 'boolean' } },
  });
  const root = repoRoot();
  let bad = 0;
  const line = (ok: boolean, text: string) => {
    if (!ok) bad++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${text}\n`);
  };
  const policy = loadPolicy(values.policy ?? join(root, 'policy'));
  line(true, `policy loads, hash ${policyHash(policy, join(root, 'prompts')).slice(0, 12)}`);
  try {
    const warnings = assertMixedFamilies(policy);
    line(true, 'at least two model families are configured');
    for (const w of warnings) process.stdout.write(`warn ${w}\n`);
  } catch (err) {
    line(false, (err as Error).message);
  }
  const pins = verifyRelayPins(root);
  line(
    pins.ok,
    pins.ok ? 'relay hashes match the pin' : `relay hashes differ: ${pins.bad.join(', ')}`,
  );
  if (!policy.settings.notify.command)
    process.stdout.write(
      "warn no notify.command: you'll hear of a stop only when you next check status\n",
    );
  if (values['notify-test'] && policy.settings.notify.command) {
    const { spawnSync } = await import('node:child_process');
    const cmd = policy.settings.notify.command;
    const r = spawnSync(cmd[0], [...cmd.slice(1), 'TEST', 'ecp doctor notify test'], {
      stdio: 'ignore',
    });
    line(r.status === 0, 'notify.command reached its channel');
  }
  // Reading a CLI's version runs it, so that waits for the guard inside the relay adapter's own probe.
  process.exitCode = bad ? 1 : 0;
}

async function cmdPublish(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'accept-base': { type: 'string' } },
  });
  if (!positionals[0]) fail('usage: ecp publish <run-id> [--accept-base <sha>]', 2);
  const runId = positionals[0];
  const { spec, cfg } = loadRunConfig(runId);
  if (!takeLock(globalLock())) fail('another run is active');
  const w = wire({ runId, spec, policyDir: cfg.policy ?? undefined, mockScript: cfg.mock_script });
  w.engine.loadForResume();
  try {
    w.engine.retryPublish(values['accept-base'] ?? null);
  } catch (err) {
    rmSync(globalLock(), { force: true });
    fail((err as Error).message);
  }
  const exit = await w.engine.loop();
  rmSync(globalLock(), { force: true });
  process.stdout.write(`${runId} ${exit.state}\n`);
  process.exitCode = exit.code;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'run':
      return cmdRun(rest);
    case 'resume':
      return cmdResume(rest);
    case 'pause':
      return cmdControl('pause', rest);
    case 'cancel':
      return cmdControl('cancel', rest);
    case 'status':
      return cmdStatus(rest);
    case 'report':
      return cmdReport(rest);
    case 'clean':
      return cmdClean(rest);
    case 'metrics':
      return cmdMetrics();
    case 'doctor':
      return cmdDoctor(rest);
    case 'publish':
      return cmdPublish(rest);
    case 'shadow-replay':
      return replayCommand(rest);
    case 'isolation-prove':
      return isolationCommand(rest);
    case 'eval':
      return evalCommand(rest);
    default:
      fail(
        'usage: ecp <doctor|run|status|resume|pause|cancel|report|clean|metrics|publish|shadow-replay|isolation-prove|eval>',
        2,
      );
  }
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
