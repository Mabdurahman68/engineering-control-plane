import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { MockScript, PolicyBundle, Spec, WorkerAdapter } from '../contracts/index.ts';
import { mockScriptSchema, runStateSchema, specSchema } from '../contracts/index.ts';
import { Engine, type RunExit } from '../core/engine.ts';
import type { EnginePorts } from '../core/ports.ts';
import { RealClock } from '../core/real-clock.ts';
import { replay, type RunR } from '../core/reducer.ts';
import { RealCommandRunner } from '../gates/runner.ts';
import { canonical, sha256 } from '../ledger/canonical.ts';
import { FsLedgerStore, loadLedger } from '../ledger/ledger.ts';
import { loadPolicy, policyHash } from '../policy/load.ts';
import { computeFigures } from '../report/figures.ts';
import { renderReport, renderStatus } from '../report/report.ts';
import { ShadowManager } from '../shadow/manager.ts';
import { MockAdapter } from '../workers/mock/mock-adapter.ts';
import { RealMockWorld } from '../workers/mock/real-world.ts';
import { RealKiller, RealScanner } from '../workers/relay/proc.ts';
import { FsRunStore } from '../worktree/fs-store.ts';
import { RealGit } from '../worktree/real-git.ts';
import { makeRelayAdapters } from '../workers/relay/adapter.ts';
import { homePath } from './home.ts';
import type { CoordinatorLock } from './lock.ts';
import { makePublisher } from '../publish/publisher.ts';

export function ecpHome(): string {
  return homePath();
}
export const runDir = (runId: string) => join(ecpHome(), 'runs', runId);

const REQUESTS = (runId: string) => join(runDir(runId), 'control', 'requests');

// An operator request, as its own file, never overwriting another. The ID is the file name.
export function writeControlRequest(runId: string, request: 'pause' | 'cancel'): string {
  const id = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  atomicWrite(join(REQUESTS(runId), `${id}.json`), JSON.stringify({ id, request }));
  return id;
}

export function pendingControlRequests(
  runId: string,
): { id: string; request: 'pause' | 'cancel' }[] {
  const dir = REQUESTS(runId);
  if (!existsSync(dir)) return [];
  const out: { id: string; request: 'pause' | 'cancel' }[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (r.request === 'pause' || r.request === 'cancel')
        out.push({ id: f.slice(0, -5), request: r.request });
    } catch {
      // Not finished being written: the rename makes it whole before it can be read.
    }
  }
  return out;
}

export function repoRoot(): string {
  return resolve(new URL('../..', import.meta.url).pathname);
}

export function loadSpecFile(path: string): Spec {
  const parsed = specSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`invalid spec: ${parsed.error.message}`);
  return parsed.data;
}

export function dayUsageFrom(home: string, excludeRun: string, now: number) {
  const out = { invocations: 0, wall_clock_s: 0, usd: 0, shadow_invocations: 0 };
  const runs = join(home, 'runs');
  if (!existsSync(runs)) return out;
  const day = new Date(now).toDateString();
  for (const r of readdirSync(runs)) {
    if (r === excludeRun) continue;
    try {
      const { events } = loadLedger(
        new FsLedgerStore(join(runs, r, 'ledger', 'events.jsonl'), { readOnly: true }),
        { repair: false },
      );
      const today = events.filter((e) => new Date(e.at).toDateString() === day);
      const f = computeFigures(today);
      out.invocations += f.invocations;
      out.wall_clock_s += f.worker_wall_s;
      out.usd += f.usage.cost_usd;
      out.shadow_invocations += today.filter((e) => e.type === 'shadow.intent').length;
    } catch {
      // A broken ledger for another run doesn't stop this one.
    }
  }
  return out;
}

function promptsFrom(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).map((f) => [f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')]),
  );
}

export type Wired = {
  engine: Engine;
  store: FsRunStore;
  ledger: FsLedgerStore;
  policy: PolicyBundle;
  spec: Spec;
  policySha: string;
  adapters: Record<string, WorkerAdapter>;
};

// The one place that builds a run. It wires exactly two adapter kinds: the mock, with a script, and
// the relay. A test checks that nothing else can reach the engine from here.
export function wire(o: {
  runId: string;
  spec: Spec;
  policyDir?: string;
  mockScript?: MockScript | null;
  lock: CoordinatorLock;
}): Wired {
  const home = ecpHome();
  // Every coordinator mutation, to the ledger or under the run, checks it still owns the lock.
  const guard = () => o.lock.assertOwner();
  const root = repoRoot();
  const policyDir = o.policyDir ?? join(root, 'policy');
  const promptsDir = join(root, 'prompts');
  const policy = loadPolicy(policyDir);
  const policySha = policyHash(policy, promptsDir);
  const dir = runDir(o.runId);
  const store = new FsRunStore(dir, guard);
  const ledger = new FsLedgerStore(join(dir, 'ledger', 'events.jsonl'), { guard });
  const clock = new RealClock();
  const adapters: Record<string, WorkerAdapter> = {};
  let mock: MockAdapter | null = null;
  if (o.mockScript) {
    mock = new MockAdapter({
      script: o.mockScript,
      clock,
      world: new RealMockWorld(),
      classes: policy.failureClasses,
      defaultPlan: (o.mockScript as any).default_plan ?? {
        tasks: [],
        proposed_risk: 'low',
        spec_defects: [],
      },
    });
    adapters.mock = mock;
  } else Object.assign(adapters, makeRelayAdapters({ policy, repoRoot: root, home, guard }));
  const failpoint = process.env.ECP_FAILPOINT;
  let failpointHits = 0;
  const engineRef: { current: Engine | null } = { current: null };
  const ports: EnginePorts = {
    git: new RealGit(o.spec.target.repo_path),
    runner: new RealCommandRunner(() => pendingControlRequests(o.runId).length > 0),
    store,
    ledgerStore: ledger,
    clock,
    ids: seededIds(o.runId),
    adapters,
    scanner: new RealScanner(),
    killer: new RealKiller(),
    observer: null,
    publisher: o.spec.publish ? makePublisher({ home, repoRoot: root, policy }) : null,
    policy,
    prompts: promptsFrom(promptsDir),
    paths: {
      worktree: (run, task, gen) => join(home, 'worktrees', run, `${task}-g${gen}`),
      checkout: (run, name) => join(home, 'worktrees', run, `co-${name}`),
    },
    // NAME or NAME@n, for the nth time that point is reached. A test can also hold the process there,
    // alive and owning the lock, until a file appears: ECP_FAILPOINT_HOLD and ECP_FAILPOINT_RELEASE.
    failpoint: (name) => {
      holdAt(name);
      if (!failpoint) return;
      const [point, nth] = failpoint.split('@');
      if (name !== point) return;
      failpointHits++;
      if (failpointHits === Number(nth ?? 1)) process.kill(process.pid, 'SIGKILL');
    },
    pendingControl: () => pendingControlRequests(o.runId),
    ackControl: (id) => {
      guard();
      rmSync(join(REQUESTS(o.runId), `${id}.json`), { force: true });
    },
    controlPollMs: 1000,
    notify: (kind, summary) => {
      guard();
      appendFileSync(
        join(home, 'notifications.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), run: o.runId, kind, summary })}\n`,
      );
      const cmd = policy.settings.notify.command;
      if (cmd) {
        const r = spawnSync(cmd[0], [...cmd.slice(1), kind, summary], {
          stdio: 'ignore',
          timeout: 30_000,
        });
        if (r.status !== 0) throw new Error('notify command failed');
      }
    },
    dayUsage: () => dayUsageFrom(home, o.runId, Date.now()),
    projectRun: (e: Engine) => project(e, o.runId),
    finishRun: (e: Engine) => finish(e, o.runId),
  };
  const engine = new Engine(
    { runId: o.runId, spec: o.spec, specSha: sha256(canonical(o.spec)), policySha },
    ports,
  );
  engineRef.current = engine;
  ports.observer = new ShadowManager(() => engineRef.current as Engine, {
    scratchDir: (id) => {
      const d = join(tmpdir(), `ecp-shadow-${process.pid}-${id}`);
      mkdirSync(d, { recursive: true });
      return d;
    },
    transport: mock ? 'mock' : 'fake_cli',
  });
  if (mock) {
    mock.shadowOracle = (attemptId) => {
      const id = /DP-\d+/.exec(attemptId)?.[0];
      const made = loadLedger(ledger).events.find(
        (e) => e.type === 'decision.made' && e.data.decision_id === id,
      );
      return {
        action: String(made?.data.action ?? 'other'),
        target: (made?.data.target as string) ?? null,
      };
    };
  }
  return { engine, store, ledger, policy, spec: o.spec, policySha, adapters };
}

const holdState = { hits: 0 };
function holdAt(name: string) {
  const at = process.env.ECP_FAILPOINT_HOLD;
  const release = process.env.ECP_FAILPOINT_RELEASE;
  if (!at || !release) return;
  const [point, nth] = at.split('@');
  if (name !== point) return;
  holdState.hits++;
  if (holdState.hits !== Number(nth ?? 1)) return;
  const tick = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(tick, 0, 0, 50);
}

function seededIds(seedText: string) {
  let seed = Number.parseInt(sha256(seedText).slice(0, 8), 16);
  return {
    next: (p: string) => `${p}-${seed++}`,
    random: () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    },
  };
}

function reportInput(e: Engine, runId: string) {
  const events = loadLedger(e.p.ledgerStore).events;
  const proposals = e.p.store
    .list('shadow')
    .filter((f) => /^DP-\d+\.json$/.test(f))
    .map((f) => JSON.parse(e.p.store.read(`shadow/${f}`) as string));
  return {
    runId,
    spec: e.spec,
    state: e.s,
    events,
    proposals,
    rungModel: (r: string) => e.rung(r)?.model ?? r,
  };
}

function project(e: Engine, runId: string) {
  const inputs = reportInput(e, runId);
  const status = renderStatus({ runId, state: e.s, events: inputs.events, now: Date.now() });
  e.p.store.write('status.txt', status.text);
  e.p.store.write('run.json', JSON.stringify(projection(e.s, runId, e), null, 2));
}

export function projection(s: RunR, runId: string, e: { o: { spec: { spec_id: string } } }) {
  return runStateSchema.parse({
    schema: 'run_state.v1',
    run_id: runId,
    spec_id: e.o.spec.spec_id,
    spec_sha: s.spec_sha,
    policy_sha: s.policy_sha,
    state: s.state,
    resume_to: s.resume_to,
    reason: s.reason,
    effective: { risk: s.risk, depth: s.depth },
    tasks: Object.fromEntries(
      Object.values(s.tasks).map((t) => [
        t.task_id,
        {
          state: t.state,
          attempt: t.attempts,
          rung_id: t.rung,
          authors: t.retained_families,
          tree_hash: t.snapshots.at(-1)?.tree ?? null,
          commit: t.commit,
        },
      ]),
    ),
    integration: {
      branch: s.integration.branch,
      tip: s.integration.tip,
      merged: s.integration.merged,
    },
    counters: {
      invocations: s.counters.invocations,
      repairs: s.counters.repairs,
      fallbacks: s.counters.fallbacks,
      wall_clock_s: s.worker_wall_s,
    },
    usage: {
      tokens: s.usage.measured ? s.usage.tokens : 'unavailable',
      cost_usd: s.usage.usd_measured ? s.usage.cost_usd : 'unavailable',
      measured_coverage: `${s.usage.measured} of ${s.usage.total} invocations`,
    },
    last_event: null,
    shadow: s.shadow,
    blockers:
      s.state.startsWith('PAUSED_') || s.state === 'ESCALATION_REQUIRED'
        ? [s.reason ?? s.state]
        : [],
  });
}

function finish(e: Engine, runId: string) {
  const text = renderReport(reportInput(e, runId));
  e.p.store.write('RUN_REPORT.md', text);
  e.append('report.written', null, { sha256: sha256(text) });
}

export function atomicWrite(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function loadMockScript(path: string): MockScript {
  const raw = parse(readFileSync(path, 'utf8'));
  const { default_plan, ...rest } = raw;
  const parsed = mockScriptSchema.safeParse(rest);
  if (!parsed.success) throw new Error(`invalid mock script: ${parsed.error.message}`);
  return { ...parsed.data, default_plan } as MockScript;
}

// Observational: read-only, no repair, nothing created.
export function readRun(runId: string) {
  const store = new FsLedgerStore(join(runDir(runId), 'ledger', 'events.jsonl'), {
    readOnly: true,
  });
  const { events } = loadLedger(store, { repair: false });
  return { events, state: replay(events) };
}

export type { RunExit };
