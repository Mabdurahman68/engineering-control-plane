import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DispatchRecord,
  DispatchRequest,
  FailureClass,
  Health,
  PolicyBundle,
  RawOutcome,
  RunHandle,
  UsageRecord,
  WorkerAdapter,
} from '../../contracts/index.ts';
import { classifyOutcome } from '../classify.ts';
import { CliRefused, execCli } from './cli.ts';
import { verifyRelayPins } from './pins.ts';
import { authoriseClis, BUILD_ALLOWS_REAL_WORKERS } from './real-worker-guard.ts';

export type CliKind = 'codex' | 'claude' | 'opencode';

const FORBIDDEN_FLAGS = [
  '--lane',
  '--resume-last',
  '--continue-last',
  '--dangerously-skip-permissions',
  '--full-access',
  '--network-access',
];

// The flags a relay is given. Pure, so a test can assert what never appears for any rung.
export function relayArgs(kind: CliKind, req: DispatchRequest, relayPath: string): string[] {
  const argv = [
    relayPath,
    '--brief',
    req.brief_path,
    '--cd',
    req.cwd,
    '--out-dir',
    req.out_dir,
    '--timeout',
    `${Math.ceil(req.timeout_s)}s`,
    '--model',
    req.model,
  ];
  if (req.mode === 'read_only') argv.push('--read-only');
  if (req.effort) {
    if (kind === 'opencode') argv.push('--variant', req.effort);
    else argv.push('--effort', req.effort);
  }
  // Ambient MCP servers don't start for review rungs. Authentication still uses CODEX_HOME.
  if (kind === 'codex' && req.mode === 'read_only')
    argv.push('--ignore-user-config', '--skip-git-repo-check');
  if (req.session_id) argv.push('--session', req.session_id);
  for (const f of FORBIDDEN_FLAGS) if (argv.includes(f)) throw new Error(`forbidden flag ${f}`);
  return argv;
}

// An explicit allowlist, not the owner's shell. API-key variables are never on it for a subscription
// rung, so a stray key can't change how a run is billed.
export function relayEnv(base: NodeJS.ProcessEnv, credentialEnv: string[]): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'CODEX_HOME',
    ...credentialEnv,
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  return env;
}

function lastJsonLine(path: string, want: (o: any) => boolean): any {
  if (!existsSync(path)) return null;
  let found: any = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const o = JSON.parse(line);
      if (want(o)) found = o;
    } catch {
      // A progress line.
    }
  }
  return found;
}

function usageFrom(kind: CliKind, outDir: string, result: any): UsageRecord | null {
  const base: UsageRecord = {
    source: 'unavailable',
    tokens: 'unavailable',
    cost_usd: 'unavailable',
    quota_snapshot: 'unavailable',
    wall_clock_s: 0,
  };
  if (kind === 'codex') {
    // Not in result.json: read it from the events.
    const turn = lastJsonLine(
      join(outDir, 'events.jsonl'),
      (o) => o.type === 'turn.completed' && o.usage,
    );
    if (!turn) return base;
    return {
      ...base,
      source: 'vendor_cli_event',
      tokens: {
        input: turn.usage.input_tokens ?? 0,
        output: turn.usage.output_tokens ?? 0,
        cached: turn.usage.cached_input_tokens ?? 0,
      },
    };
  }
  if (kind === 'claude') {
    if (!result?.usage && typeof result?.totalCostUsd !== 'number') return base;
    return {
      ...base,
      source: 'vendor_cli_result',
      tokens: result.usage
        ? {
            input: result.usage.input_tokens ?? 0,
            output: result.usage.output_tokens ?? 0,
            cached: result.usage.cache_read_input_tokens ?? 0,
          }
        : 'unavailable',
      cost_usd: typeof result.totalCostUsd === 'number' ? result.totalCostUsd : 'unavailable',
    };
  }
  return typeof result?.cost === 'number'
    ? { ...base, source: 'vendor_cli_result', cost_usd: result.cost }
    : base;
}

function processStart(pid: number): string | null {
  try {
    return (
      execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
        .trim()
        .replace(/\s+/g, ' ') || null
    );
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Live = {
  req: Pick<DispatchRequest, 'out_dir'>;
  pid: number | null;
  cancelled: boolean;
  provenance: 'fake_cli' | 'real';
  done: Promise<RawOutcome>;
};

export class DelegateRelayAdapter implements WorkerAdapter {
  readonly id: string;
  private readonly kind: CliKind;
  private readonly repoRoot: string;
  private readonly policy: PolicyBundle;
  private readonly live = new Map<string, Live>();
  constructor(o: { id: string; kind: CliKind; repoRoot: string; policy: PolicyBundle }) {
    this.id = o.id;
    this.kind = o.kind;
    this.repoRoot = o.repoRoot;
    this.policy = o.policy;
  }
  private relayPath() {
    return join(this.repoRoot, 'vendor/delegate-skills', `${this.kind}-delegate`, 'relay.mjs');
  }
  // Never spends quota. Every call to the CLI here passes the guard first.
  async probe(_rungId: string): Promise<Health> {
    const none: Health = {
      installed: false,
      cli_version: null,
      version_ok: false,
      auth: 'unknown',
      quota: 'unknown',
      detail: '',
    };
    const env = relayEnv(process.env, []);
    const pins = verifyRelayPins(this.repoRoot);
    if (!pins.ok) return { ...none, detail: `relay hash mismatch: ${pins.bad.join(', ')}` };
    let version: { code: number; stdout: string };
    try {
      version = execCli(this.repoRoot, this.kind, ['--version'], env);
    } catch (err) {
      if (err instanceof CliRefused) return { ...none, detail: err.message };
      return { ...none, detail: String(err) };
    }
    if (version.code !== 0) return { ...none, detail: 'version check failed' };
    const text = version.stdout.trim();
    const range = this.policy.cliVersions.adapters[this.id];
    const number = /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null;
    const versionOk = range
      ? number === range.min || number === range.max || this.policy.settings.allow_untested_cli
      : true;
    const help = range
      ? execCli(this.repoRoot, this.kind, range.help_args, env)
      : { stdout: '', code: 0 };
    const flagsOk = !range || range.required_flags.every((f) => help.stdout.includes(f));
    let auth: Health['auth'] = 'unknown';
    if (this.kind === 'codex') {
      const login = execCli(this.repoRoot, 'codex', ['login', 'status'], env);
      auth = /Logged in/.test(login.stdout) ? 'yes' : 'no';
    }
    return {
      installed: true,
      cli_version: text,
      version_ok: versionOk && flagsOk,
      auth,
      quota: 'unknown',
      detail: flagsOk ? 'ok' : 'a required flag is missing',
    };
  }
  async dispatch(req: DispatchRequest): Promise<RunHandle> {
    const env = relayEnv(process.env, req.env_allowlist);
    const auth = authoriseClis(this.repoRoot, env.PATH ?? '');
    if (!auth.allowed) throw new CliRefused(auth.reason);
    const pins = verifyRelayPins(this.repoRoot);
    if (!pins.ok) throw new Error(`relay hash mismatch: ${pins.bad.join(', ')}`);
    mkdirSync(req.out_dir, { recursive: true });
    const out = openSync(join(req.out_dir, 'relay.stdout'), 'a');
    const err = openSync(join(req.out_dir, 'relay.stderr'), 'a');
    const child = spawn(process.execPath, relayArgs(this.kind, req, this.relayPath()), {
      cwd: req.cwd,
      env,
      detached: true,
      stdio: ['ignore', out, err],
    });
    closeSync(out);
    closeSync(err);
    const pid = child.pid ?? null;
    const done = new Promise<RawOutcome>((resolve) => {
      child.on('close', () => resolve(this.readOutcome(req.out_dir, entry)));
      child.on('error', () => resolve({ ...this.missing(), spawn_failed: true }));
    });
    const entry: Live = { req, pid, cancelled: false, provenance: auth.provenance, done };
    this.live.set(req.attempt_id, entry);
    child.unref();
    return { attempt_id: req.attempt_id, pid, start_time: pid ? processStart(pid) : null };
  }
  private missing(): RawOutcome {
    return {
      relay_status: null,
      exit_code: null,
      signal: null,
      final_message: '',
      stderr_tail: '',
      session_id: null,
      model_reported: null,
      usage: null,
      result_present: false,
      transport_provenance: 'fake_cli',
      cancelled_by_us: false,
    };
  }
  private readOutcome(outDir: string, entry: Pick<Live, 'cancelled' | 'provenance'>): RawOutcome {
    const path = join(outDir, 'result.json');
    if (!existsSync(path))
      return {
        ...this.missing(),
        transport_provenance: entry.provenance,
        cancelled_by_us: entry.cancelled,
      };
    const r = JSON.parse(readFileSync(path, 'utf8'));
    const reported = lastJsonLine(
      join(outDir, 'events.jsonl'),
      (o) => o.type === 'model' && o.model,
    );
    return {
      relay_status: r.status ?? null,
      exit_code: r.exitCode ?? null,
      signal: r.signal ?? null,
      final_message: r.finalMessage ?? '',
      stderr_tail: (r.stderrTail ?? []).join('\n'),
      session_id: r.threadId ?? r.sessionId ?? null,
      // The relay's `model` only echoes the request, so it isn't evidence of what served it.
      model_reported: reported?.model ?? null,
      usage: usageFrom(this.kind, outDir, r),
      result_present: true,
      transport_provenance: entry.provenance,
      cancelled_by_us: entry.cancelled,
    };
  }
  wait(h: RunHandle): Promise<RawOutcome> {
    const e = this.live.get(h.attempt_id);
    if (!e) return Promise.resolve(this.missing());
    return e.done;
  }
  async attach(rec: DispatchRecord): Promise<RunHandle | 'gone'> {
    // A result collected on resume was launched past the guard, so nothing real can be behind it here.
    const provenance = BUILD_ALLOWS_REAL_WORKERS ? ('real' as const) : ('fake_cli' as const);
    const hasResult = existsSync(join(rec.out_dir, 'result.json'));
    if (rec.pid === null) {
      // The caller has killed what was left, and wants only a result that was published.
      if (!hasResult) return 'gone';
      const entry: Live = {
        req: rec,
        pid: null,
        cancelled: false,
        provenance,
        done: Promise.resolve(this.missing()),
      };
      entry.done = Promise.resolve(this.readOutcome(rec.out_dir, entry));
      this.live.set(rec.attempt_id, entry);
      return { attempt_id: rec.attempt_id, pid: null, start_time: null };
    }
    // Proven live: no signal, and poll for its result.
    const pid = rec.pid;
    const entry: Live = {
      req: rec,
      pid,
      cancelled: false,
      provenance,
      done: new Promise<RawOutcome>((resolve) => {
        const tick = setInterval(() => {
          if (alive(pid)) return;
          clearInterval(tick);
          resolve(this.readOutcome(rec.out_dir, entry));
        }, 200);
      }),
    };
    this.live.set(rec.attempt_id, entry);
    return { attempt_id: rec.attempt_id, pid, start_time: rec.start_time };
  }
  // SIGTERM, then SIGKILL. Whatever's left after this is the shared sweep's job, always.
  async cancel(h: RunHandle): Promise<void> {
    const e = this.live.get(h.attempt_id);
    if (!e) return;
    e.cancelled = true;
    if (e.pid === null) return;
    try {
      process.kill(e.pid, 'SIGTERM');
    } catch {
      return;
    }
    const pid = e.pid;
    // Held on purpose: while this waits, nothing else may be keeping the process alive.
    const hardStop = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }, 15_000);
    await e.done;
    clearTimeout(hardStop);
  }
  classify(o: RawOutcome): FailureClass {
    return classifyOutcome(o, this.policy.failureClasses, this.id);
  }
  usage(o: RawOutcome): UsageRecord {
    return (
      o.usage ?? {
        source: 'unavailable',
        tokens: 'unavailable',
        cost_usd: 'unavailable',
        quota_snapshot: 'unavailable',
        wall_clock_s: 0,
      }
    );
  }
}

export function makeRelayAdapters(o: {
  policy: PolicyBundle;
  repoRoot: string;
  home: string;
}): Record<string, WorkerAdapter> {
  const out: Record<string, WorkerAdapter> = {};
  for (const [id, kind] of [
    ['codex-relay', 'codex'],
    ['claude-relay', 'claude'],
    ['opencode-relay', 'opencode'],
  ] as const) {
    out[id] = new DelegateRelayAdapter({ id, kind, repoRoot: o.repoRoot, policy: o.policy });
  }
  return out;
}
