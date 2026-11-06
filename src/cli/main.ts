#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { decisionSchema } from '../contracts/index.ts';
import { assertMixedFamilies, loadPolicy, policyHash } from '../policy/load.ts';
import { renderMetrics, renderStatus } from '../report/report.ts';
import { makeRelayAdapters } from '../workers/relay/adapter.ts';
import { verifyRelayPins } from '../workers/relay/pins.ts';
import { authoriseClis } from '../workers/relay/real-worker-guard.ts';
import { replayCommand } from './replay-cmd.ts';
import { evalCommand } from './eval-cmd.ts';
import { isolationCommand } from './isolation-cmd.ts';
import { HomeRefused, homePath, lockPathIn, prepareHome } from './home.ts';
import { acquireLock, type CoordinatorLock, readLockMeta } from './lock.ts';
import {
  ecpHome,
  loadMockScript,
  loadSpecFile,
  readRun,
  repoRoot,
  runDir,
  wire,
  writeControlRequest,
} from './wire.ts';

function fail(message: string, code = 1): never {
  process.stderr.write(`ecp: ${message}\n`);
  process.exit(code);
}

// Validated before anything is created in it. A home this version didn't make is refused.
function openHome(): string {
  try {
    return prepareHome();
  } catch (err) {
    if (err instanceof HomeRefused) fail(err.message, 3);
    throw err;
  }
}

// The kernel lock, held until this process ends or releases it. One active run at a time.
function takeCoordinator(runId: string): CoordinatorLock {
  const home = openHome();
  const r = acquireLock(lockPathIn(home));
  if (r.ok) {
    r.lock.writeMeta(runId);
    return r.lock;
  }
  if (r.held) {
    const m = readLockMeta(lockPathIn(home));
    fail(`another run is active${m ? ` (run ${m.run_id})` : ''}: one active run at a time`);
  }
  fail(`the coordinator lock could not be taken: ${r.error}`, 2);
}

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
  const mockScript = values['mock-script'] ? loadMockScript(values['mock-script']) : null;
  if (!mockScript) {
    // Anything that isn't a pinned fixture is a real CLI, and this is the plain place to say so.
    const auth = authoriseClis(repoRoot(), process.env.PATH ?? '');
    if (!auth.allowed) fail(`refused: ${auth.reason}`, 3);
  }
  const lock = takeCoordinator(runId);
  const w = wire({ runId, spec, policyDir: values.policy, mockScript, lock });
  w.store.write('spec.yaml', readFileSync(specPath, 'utf8'));
  w.store.write('policy.lock', JSON.stringify({ sha256: w.policySha }));
  w.store.write(
    'run-config.json',
    JSON.stringify({ policy: values.policy ?? null, mock_script: mockScript }),
  );
  w.engine.createRun();
  const exit = await w.engine.loop();
  lock.release();
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
  held?: CoordinatorLock,
) {
  const { spec, cfg } = loadRunConfig(runId);
  // A control command that took the lock passes it in: no release and re-take in between.
  const lock = held ?? takeCoordinator(runId);
  const w = wire({
    runId,
    spec,
    policyDir: cfg.policy ?? undefined,
    mockScript: cfg.mock_script,
    lock,
  });
  const locked = JSON.parse(w.store.read('policy.lock') as string).sha256;
  if (locked !== w.policySha && !opts.accept) {
    lock.release();
    fail('policy changed since the run started: use --accept-policy-change', 1);
  }
  let decision: Record<string, unknown> | undefined;
  if (opts.decisionFile) {
    const parsed = decisionSchema.safeParse(parse(readFileSync(opts.decisionFile, 'utf8')));
    if (!parsed.success) {
      lock.release();
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
  lock.release();
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
  const home = openHome();
  if (!existsSync(runDir(runId))) fail(`no such run: ${runId}`);
  // Durable first: whatever happens next, the request is on disk, and every resume reads it.
  writeControlRequest(runId, request);
  const r = acquireLock(lockPathIn(home));
  if (r.ok) {
    // No coordinator: this process is it, for the moment, and applies the request itself.
    r.lock.writeMeta(runId);
    await runResume(runId, {}, r.lock);
    return;
  }
  if (r.held) {
    const active = readLockMeta(lockPathIn(home))?.run_id ?? 'unknown';
    process.stdout.write(
      `${request} recorded for ${runId}; a coordinator is active (run ${active}). It applies at once if that is ${runId}, otherwise when ${runId} next resumes.\n`,
    );
    return;
  }
  process.stdout.write(
    `${request} recorded for ${runId}; the lock could not be attempted: ${r.error}\n`,
  );
  process.exitCode = 2;
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
  // It removes worktrees, so it holds the lock like any other mutation.
  const lock = takeCoordinator('clean');
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
  lock.release();
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
  process.stdout.write(
    `info home ${homePath()}. Don't point an older ecp's ECP_HOME at it, and keep it on a local APFS or HFS volume: the coordinator lock depends on both\n`,
  );
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
  // Reading a CLI's version runs it, so it happens only inside the relay adapter, after the guard.
  for (const adapter of Object.values(
    makeRelayAdapters({ policy, repoRoot: root, home: ecpHome() }),
  )) {
    const h = await adapter.probe(adapter.id);
    if (h.installed) line(h.version_ok, `${adapter.id}: ${h.cli_version}, auth ${h.auth}`);
    else process.stdout.write(`warn ${adapter.id} unavailable: ${h.detail}\n`);
  }
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
  const lock = takeCoordinator(runId);
  const w = wire({
    runId,
    spec,
    policyDir: cfg.policy ?? undefined,
    mockScript: cfg.mock_script,
    lock,
  });
  w.engine.loadForResume();
  try {
    w.engine.retryPublish(values['accept-base'] ?? null);
  } catch (err) {
    lock.release();
    fail((err as Error).message);
  }
  const exit = await w.engine.loop();
  lock.release();
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
