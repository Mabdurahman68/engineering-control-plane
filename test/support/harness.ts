import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, type RunExit } from '../../src/core/engine.ts';
import { canonical, sha256 } from '../../src/ledger/canonical.ts';
import type { EnginePorts, ProcKiller, ProcScanner } from '../../src/core/ports.ts';
import type {
  DecisionObserver,
  MockScript,
  PolicyBundle,
  Spec,
  WorkerAdapter,
} from '../../src/contracts/index.ts';
import { loadLedger, type LedgerStore, MemLedgerStore } from '../../src/ledger/ledger.ts';
import { loadPolicy } from '../../src/policy/load.ts';
import { MockAdapter, type MockWorld } from '../../src/workers/mock/mock-adapter.ts';
import { MemRunStore } from '../../src/worktree/fs-store.ts';
import type { CommandRunner, GitPort, RunStore } from '../../src/worktree/port.ts';
import { RealClock } from '../../src/core/real-clock.ts';
import { RealCommandRunner } from '../../src/gates/runner.ts';
import { FsLedgerStore } from '../../src/ledger/ledger.ts';
import { RealMockWorld } from '../../src/workers/mock/real-world.ts';
import { FsRunStore } from '../../src/worktree/fs-store.ts';
import { RealGit } from '../../src/worktree/real-git.ts';
import { makeRepo, tempDir } from './repo.ts';
import { ShadowManager } from '../../src/shadow/manager.ts';
import { SimGit, SimRunner, VirtualClock } from './sim.ts';

const realPolicy = loadPolicy('policy');
export const PROMPTS = Object.fromEntries(
  readdirSync('prompts').map((f) => [
    f.replace(/\.md$/, ''),
    readFileSync(join('prompts', f), 'utf8'),
  ]),
);

export function testPolicy(over: (p: PolicyBundle) => void = () => {}): PolicyBundle {
  const p = structuredClone(realPolicy);
  const rung = (model: string) => ({
    adapter: 'mock',
    model,
    auth_mode: 'subscription' as const,
    credential_env: [],
  });
  p.workers.rungs = {
    'mock-openai': rung('mock-model-openai'),
    'mock-anthropic': rung('mock-model-anthropic'),
    'mock-glm': rung('mock-model-glm'),
    'mock-openai-2': rung('mock-model-openai-2'),
    'mock-anthropic-2': rung('mock-model-anthropic-2'),
    'mock-glm-2': rung('mock-model-glm-2'),
  };
  const writers = ['mock-openai', 'mock-glm', 'mock-anthropic'];
  const readers = [
    'mock-anthropic',
    'mock-openai',
    'mock-glm',
    'mock-anthropic-2',
    'mock-openai-2',
    'mock-glm-2',
  ];
  p.workers.ladders = {
    planning: readers,
    research: writers,
    implementation: writers,
    'hard-code': writers,
    tests: writers,
    'integration-repair': ['mock-openai', 'mock-anthropic', 'mock-glm'],
    review: readers,
    adversarial: readers,
    adjudication: readers,
    shadow: ['mock-openai', 'mock-anthropic', 'mock-glm'],
  };
  p.families.models = {
    'mock-model-openai': 'openai',
    'mock-model-anthropic': 'anthropic',
    'mock-model-glm': 'glm',
    'mock-model-openai-2': 'openai',
    'mock-model-anthropic-2': 'anthropic',
    'mock-model-glm-2': 'glm',
  };
  over(p);
  return p;
}

export const defaultPlan = (ids = ['T1', 'T2', 'T3']) => ({
  tasks: ids.map((id, i) => ({
    task_id: id,
    goal: `do ${id}`,
    lane: 'implementation',
    allowed_paths: [`src/${id.toLowerCase()}/**`],
    forbidden_paths: [],
    acceptance_criteria: i === 0 ? ['AC-1'] : [],
    required_tests: ['unit'],
    depends_on: i === 2 ? ['T1'] : [],
  })),
  proposed_risk: 'low',
  spec_defects: [],
});

export function testSpec(root: string, over: Partial<Spec> = {}): Spec {
  return {
    schema: 'spec.v1',
    spec_id: 'SPEC-T',
    title: 't',
    goal: 'g',
    target: { repo_path: '/sim/repo', base_commit: root, repo_identity: root },
    requested_depth: 'STANDARD',
    declared_risk: 'low',
    data_classes: [],
    product_behaviour: '',
    non_goals: [],
    architecture_decisions: [],
    affected_surfaces: [],
    invariants: [],
    acceptance_criteria: [
      {
        id: 'AC-1',
        text: 'it works',
        human_reserved: false,
        verify: [{ kind: 'semantic', question: 'does it?' }],
      },
    ],
    required_tests: [{ id: 'unit', command: ['sim', 'unit'], timeout_s: 60 }],
    full_test_command: { command: ['sim', 'full'], timeout_s: 60 },
    expect_red_baseline: false,
    gate_commands: {},
    known_control_files: [],
    allowed_control_paths: [],
    human_decision_boundaries: [],
    rollback_expectation: '',
    ...over,
  };
}

export const scanNone: ProcScanner = { scan: async () => [], isAlive: async () => false };
export const killNone: ProcKiller = { kill: async () => {}, sleep: async () => {} };

export type Sim = {
  git: SimGit;
  runner: SimRunner;
  clock: VirtualClock;
  store: MemRunStore;
  ledger: MemLedgerStore;
  adapter: MockAdapter;
  policy: PolicyBundle;
  spec: Spec;
  control: { request: 'pause' | 'cancel' } | null;
  notifications: { kind: string; summary: string }[];
  engine: Engine;
  ports: EnginePorts;
  failFn: (name: string) => void;
};

let controlSeq = 0;

export function makePorts(o: {
  git: GitPort;
  runner: CommandRunner;
  clock: EnginePorts['clock'];
  store: RunStore;
  ledger: LedgerStore;
  adapters: Record<string, WorkerAdapter>;
  policy: PolicyBundle;
  control: { get(): { request: 'pause' | 'cancel' } | null; clear(): void };
  notify: (k: string, s: string) => void;
  failpoint: (n: string) => void;
  observer?: DecisionObserver | null;
  scanner?: ProcScanner;
  killer?: ProcKiller;
  publisher?: EnginePorts['publisher'];
  worktreeRoot?: string;
}): EnginePorts {
  let seed = 12345;
  const root = o.worktreeRoot ?? '/sim/wt';
  return {
    git: o.git,
    runner: o.runner,
    store: o.store,
    ledgerStore: o.ledger,
    clock: o.clock,
    ids: {
      next: (p) => `${p}-${seed++}`,
      random: () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      },
    },
    adapters: o.adapters,
    scanner: o.scanner ?? scanNone,
    killer: o.killer ?? killNone,
    observer: o.observer ?? null,
    publisher: o.publisher ?? null,
    policy: o.policy,
    prompts: PROMPTS,
    paths: {
      worktree: (run, task, gen) => `${root}/${run}/${task}-g${gen}`,
      checkout: (run, name) => `${root}/${run}/co-${name}`,
    },
    failpoint: o.failpoint,
    // A test sets sim.control; it gets an ID the first time it's seen, and goes once acknowledged.
    pendingControl: () => {
      const c = o.control.get() as any;
      if (!c) return [];
      c.id ??= `C-${++controlSeq}`;
      return [{ id: c.id, request: c.request }];
    },
    ackControl: (id: string) => {
      if ((o.control.get() as any)?.id === id) o.control.clear();
    },
    notify: o.notify,
    dayUsage: () => ({ invocations: 0, wall_clock_s: 0, usd: 0, shadow_invocations: 0 }),
  };
}

export function makeSim(
  o: {
    script?: MockScript['steps'];
    probes?: MockScript['probes'];
    files?: Record<string, string>;
    spec?: Partial<Spec>;
    policy?: (p: PolicyBundle) => void;
    plan?: ReturnType<typeof defaultPlan>;
    observer?: DecisionObserver | null;
    prep?: (sim: any) => void;
    shadow?: boolean;
    adapterOverride?: (sim: {
      git: SimGit;
      clock: VirtualClock;
      store: MemRunStore;
      policy: PolicyBundle;
    }) => WorkerAdapter;
  } = {},
): Sim {
  const git = new SimGit(o.files ?? { 'README.md': 'x\n' });
  const clock = new VirtualClock();
  const store = new MemRunStore();
  const ledger = new MemLedgerStore();
  const policy = testPolicy(o.policy);
  git.readBriefFn = (p) => store.read(p.replace('/mem/', ''));
  const adapter = new MockAdapter({
    script: { schema: 'mock_script.v1', steps: o.script ?? [], probes: o.probes },
    clock,
    world: git as MockWorld,
    classes: policy.failureClasses,
    defaultPlan: o.plan ?? defaultPlan(),
  });
  const runner = new SimRunner(git);
  const spec = testSpec(git.root, o.spec);
  const sim: any = {
    git,
    runner,
    clock,
    store,
    ledger,
    adapter,
    policy,
    spec,
    control: null,
    notifications: [],
    failFn: () => {},
  };
  const adapters: Record<string, WorkerAdapter> = {
    mock: o.adapterOverride ? o.adapterOverride(sim) : adapter,
  };
  sim.ports = makePorts({
    git,
    runner,
    clock,
    store,
    ledger,
    adapters,
    policy,
    observer: o.observer ?? null,
    scanner: {
      scan: async (a) => {
        const rec = adapter.processFor(a.attempt_id);
        return rec ? [rec] : [];
      },
      isAlive: async (pid) => adapter.isAlivePid(pid),
    },
    killer: {
      kill: async (pids, signal) => {
        for (const pid of pids) adapter.signalPid(pid, signal);
      },
      sleep: async () => {},
    },
    failpoint: (n) => sim.failFn(n),
    notify: (kind, summary) => sim.notifications.push({ kind, summary }),
    control: {
      get: () => sim.control,
      clear: () => {
        sim.control = null;
      },
    },
  });
  sim.engine = new Engine(
    { runId: 'run1', spec, specSha: sha256(canonical(spec)), policySha: 'b'.repeat(64) },
    sim.ports,
  );
  if (o.shadow) {
    sim.ports.observer = new ShadowManager(() => sim.engine, {
      scratchDir: (id) => `/sim/scratch/${id}`,
      transport: 'mock',
    });
    adapter.shadowOracle = (attemptId) => {
      const id = /DP-\d+/.exec(attemptId)?.[0];
      const made = loadLedger(ledger).events.find(
        (e) => e.type === 'decision.made' && e.data.decision_id === id,
      );
      return {
        action: String(made?.data.action ?? 'other'),
        target: (made?.data.target as string) ?? null,
      };
    };
    sim.git.worktrees.set('/sim/scratch', { files: {}, head: sim.git.root });
  }
  o.prep?.(sim);
  return sim as Sim;
}

export async function runSim(sim: Sim): Promise<RunExit> {
  sim.engine.createRun();
  return sim.engine.loop();
}

// A fresh engine on the same world, as after a crash or a stop. Returns the new engine's exit.
export async function resumeSim(
  sim: Sim,
  opts: { decision?: Record<string, unknown>; extendBudget?: number; acceptPolicy?: boolean } = {},
): Promise<RunExit> {
  sim.engine = new Engine(
    {
      runId: 'run1',
      spec: sim.spec,
      specSha: sha256(canonical(sim.spec)),
      policySha: 'b'.repeat(64),
    },
    sim.ports,
  );
  sim.engine.loadForResume();
  await sim.engine.resumeRun({ ...opts, policySha: 'b'.repeat(64) });
  return sim.engine.loop();
}

export function trace(sim: Sim) {
  return events(sim)
    .filter(
      (e) => !['heartbeat', 'usage.recorded', 'decision.made', 'claim.recorded'].includes(e.type),
    )
    .map((e) => `${e.seq} ${e.type} ${e.task_id ?? ''} ${JSON.stringify(e.data).slice(0, 180)}`)
    .join('\n');
}

export function events(sim: Sim) {
  return loadLedger(sim.ledger).events;
}
export function ofType(sim: Sim, type: string) {
  return events(sim).filter((e) => e.type === type);
}
export function decision(escalationId: string, optionId: string, target?: string) {
  return {
    schema: 'decision.v1',
    escalation_id: escalationId,
    option_id: optionId,
    note: 'owner note',
    new_information: false,
    authority_exercised: false,
    decided_by: 'owner',
    target,
  };
}

export type RealSim = {
  repo: string;
  home: string;
  base: string;
  git: RealGit;
  store: FsRunStore;
  ledger: FsLedgerStore;
  adapter: MockAdapter;
  policy: PolicyBundle;
  spec: Spec;
  engine: Engine;
  ports: EnginePorts;
  control: { request: 'pause' | 'cancel' } | null;
  specSha: string;
};

// The same engine, on a real repository, real files and a real ledger.
export function makeReal(
  o: {
    files?: Record<string, string>;
    script?: MockScript['steps'];
    probes?: MockScript['probes'];
    spec?: Partial<Spec>;
    plan?: ReturnType<typeof defaultPlan>;
    policy?: (p: PolicyBundle) => void;
  } = {},
): RealSim {
  const r = makeRepo(o.files ?? { 'README.md': 'x\n' });
  const home = tempDir('ecp-home-');
  const git = new RealGit(r.dir);
  const store = new FsRunStore(join(home, 'runs/run1'));
  const ledger = new FsLedgerStore(join(home, 'runs/run1/ledger/events.jsonl'));
  const clock = new RealClock();
  const policy = testPolicy(o.policy);
  const adapter = new MockAdapter({
    script: { schema: 'mock_script.v1', steps: o.script ?? [], probes: o.probes },
    clock,
    world: new RealMockWorld(),
    classes: policy.failureClasses,
    defaultPlan: o.plan ?? defaultPlan(),
  });
  const node = process.execPath;
  const spec = testSpec(r.base, {
    target: { repo_path: r.dir, base_commit: r.base, repo_identity: r.base },
    required_tests: [{ id: 'unit', command: [node, '-e', 'process.exit(0)'], timeout_s: 30 }],
    full_test_command: { command: [node, '-e', 'process.exit(0)'], timeout_s: 30 },
    ...o.spec,
  });
  const sim: any = {
    home,
    repo: r.dir,
    base: r.base,
    git,
    store,
    ledger,
    adapter,
    policy,
    spec,
    control: null,
    specSha: sha256(canonical(spec)),
  };
  sim.ports = makePorts({
    git,
    runner: new RealCommandRunner(),
    clock,
    store,
    ledger,
    adapters: { mock: adapter },
    policy,
    worktreeRoot: join(home, 'worktrees'),
    failpoint: () => {},
    notify: () => {},
    control: {
      get: () => sim.control,
      clear: () => {
        sim.control = null;
      },
    },
  });
  sim.engine = new Engine(
    { runId: 'run1', spec, specSha: sim.specSha, policySha: 'b'.repeat(64) },
    sim.ports,
  );
  return sim as RealSim;
}

export async function runReal(sim: RealSim): Promise<RunExit> {
  sim.engine.createRun();
  return sim.engine.loop();
}
