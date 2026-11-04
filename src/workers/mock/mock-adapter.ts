import type {
  DispatchRecord,
  DispatchRequest,
  FailureClass,
  FailureClasses,
  Health,
  MockScript,
  RawOutcome,
  RunHandle,
  ScriptStep,
  UsageRecord,
  WorkerAdapter,
} from '../../contracts/index.ts';
import { SEMANTIC_CHECKS } from '../../contracts/index.ts';
import type { Clock } from '../../core/ports.ts';
import { classifyOutcome } from '../classify.ts';

// What the mock can do to a worktree. A real filesystem, or the in-memory model.
export interface MockWorld {
  writeFile(cwd: string, path: string, content: string | null): void | Promise<void>;
  commitHead(cwd: string): void | Promise<void>;
  tamperConfig(cwd: string): void | Promise<void>;
  readFileIn(cwd: string, path: string): string | null | Promise<string | null>;
  readBrief(path: string): string | null;
  // A fake relay that outlives the coordinator (re-attach path); absent in a real-process mock.
  survivors?: Map<string, MockRun>;
}

export type MockRun = {
  attempt_id: string;
  pid: number;
  start_time: string;
  outcome: Promise<RawOutcome>;
  resolveNow: (o: RawOutcome) => void;
  ignoresTerm: boolean;
  signals: string[];
  req: DispatchRequest;
  settled: boolean;
  last: RawOutcome | null;
};

const USAGE: UsageRecord = {
  source: 'unavailable',
  tokens: 'unavailable',
  cost_usd: 'unavailable',
  quota_snapshot: 'unavailable',
  wall_clock_s: 0,
};

function outcome(over: Partial<RawOutcome>): RawOutcome {
  return {
    relay_status: 'completed',
    exit_code: 0,
    signal: null,
    final_message: '',
    stderr_tail: '',
    session_id: null,
    model_reported: null,
    usage: null,
    result_present: true,
    transport_provenance: 'mock',
    cancelled_by_us: false,
    ...over,
  };
}

const block = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function workerReport(over: Record<string, unknown> = {}) {
  return {
    status: 'done',
    summary: 'ok',
    claims: [],
    tests_run_claimed: [],
    known_issues: [],
    disputed_findings: [],
    ...over,
  };
}

function reviewPass(acs: string[], files: string[]) {
  const semantic = Object.fromEntries(
    SEMANTIC_CHECKS.map((n) => [n, { verdict: 'PASS', note: 'ok', finding_refs: [] }]),
  );
  return {
    verdict: 'PASS',
    criteria: acs.map((ac) => ({ ac, verdict: 'PASS', evidence: 'looked', finding_refs: [] })),
    semantic_checks: semantic,
    findings: [],
    claims_reviewed: [],
    looked_at: { files, commands: [], not_examined: [] },
  };
}

// Builds a consistent FAIL: each blocking finding is linked to its criterion or a semantic check.
export function reviewFail(
  acs: string[],
  files: string[],
  findings: any[],
  fallbackFile: string | null,
) {
  const r: any = reviewPass(acs, files);
  r.verdict = 'FAIL';
  r.findings = findings.map((f, i) => ({
    criterion: 'none',
    category: 'logic',
    finding_type: 'wrong_behaviour',
    subject: `defect ${i}`,
    observed: `observed ${i}`,
    expected: `expected ${i}`,
    severity: 'major',
    file: fallbackFile,
    line: null,
    message: 'fix it',
    required_repair: 'fix it',
    ...f,
  }));
  r.findings.forEach((f: any, i: number) => {
    if (f.severity !== 'blocker' && f.severity !== 'major') return;
    const crit = r.criteria.find((c: any) => c.ac === f.criterion);
    if (crit) {
      crit.verdict = 'FAIL';
      crit.finding_refs.push(i);
    } else {
      r.semantic_checks.spec_fidelity.verdict = 'FAIL';
      r.semantic_checks.spec_fidelity.finding_refs.push(i);
    }
  });
  return r;
}

export type DefaultPlan = { tasks: any[]; proposed_risk: string; spec_defects: any[] };

export class MockAdapter implements WorkerAdapter {
  readonly id = 'mock';
  private readonly script: MockScript;
  private readonly clock: Clock;
  private readonly world: MockWorld;
  private readonly classes: FailureClasses;
  private readonly defaultPlan: DefaultPlan;
  private readonly used = new Map<ScriptStep, number>();
  private readonly runs = new Map<string, MockRun>();
  private nextPid = 1000;
  log: { step: string; task: string | null; rung: string; n: number; behaviour: string }[] = [];

  constructor(o: {
    script: MockScript;
    clock: Clock;
    world: MockWorld;
    classes: FailureClasses;
    defaultPlan: DefaultPlan;
  }) {
    this.script = o.script;
    this.clock = o.clock;
    this.world = o.world;
    this.classes = o.classes;
    this.defaultPlan = o.defaultPlan;
  }

  async probe(rungId: string): Promise<Health> {
    const p = this.script.probes?.[rungId] ?? 'ok';
    return {
      installed: p !== 'not_installed',
      cli_version: 'mock',
      version_ok: p !== 'bad_version' && p !== 'missing_flag',
      auth: p === 'auth_no' ? 'no' : 'yes',
      quota: p === 'quota_exhausted' ? 'exhausted' : 'ok',
      detail: p,
    };
  }

  setProbe(rungId: string, value: NonNullable<MockScript['probes']>[string]) {
    this.script.probes = { ...this.script.probes, [rungId]: value };
  }

  private findStep(req: DispatchRequest): ScriptStep | null {
    const m = req.meta;
    if (!m) return null;
    for (const s of this.script.steps) {
      const w = s.match;
      if (w.task !== undefined && w.task !== m.task_id) continue;
      if (w.step !== undefined && w.step !== m.step) continue;
      if (w.attempt !== undefined && w.attempt !== m.n) continue;
      if (w.rung !== undefined && w.rung !== m.rung) continue;
      if (w.point !== undefined && w.point !== m.point) continue;
      const used = this.used.get(s) ?? 0;
      if (s.times !== undefined && used >= s.times) continue;
      this.used.set(s, used + 1);
      return s;
    }
    return null;
  }

  private defaultBehaviour(step: string): ScriptStep['behaviour'] {
    switch (step) {
      case 'plan':
        return 'planner_valid';
      case 'challenge':
        return 'challenge_none';
      case 'adjudicate':
        return 'adjudicate';
      case 'shadow':
        return 'shadow_agree';
      case 'work':
      case 'repair':
        return 'ok';
      default:
        return 'reviewer_pass';
    }
  }

  private defaultEdits(req: DispatchRequest) {
    const m = req.meta;
    const first = m?.allowed_paths[0] ?? 'src/**';
    const dir = first.replace(/\*.*$/, '').replace(/\/$/, '');
    const name = `${dir ? `${dir}/` : ''}${m?.task_id ?? 'x'}-${m?.n ?? 1}.txt`;
    return [{ path: name, content: `${m?.task_id} attempt ${m?.n}\n` }];
  }

  private async apply(req: DispatchRequest, edits: { path: string; content: string | null }[]) {
    for (const e of edits) await this.world.writeFile(req.cwd, e.path, e.content);
  }

  private briefBlock(req: DispatchRequest, label: string): any {
    const text = this.world.readBrief(req.brief_path) ?? '';
    const m = new RegExp(`<data label="${label}">\\n([\\s\\S]*?)\\n</data>`).exec(text);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return m[1];
    }
  }

  // Performs a behaviour's side effects, and returns the outcome the relay would report.
  private async perform(
    req: DispatchRequest,
    step: ScriptStep | null,
    behaviour: ScriptStep['behaviour'],
  ): Promise<RawOutcome> {
    const args: any = step?.args;
    const meta = req.meta;
    const acs = meta?.scope.acs ?? [];
    const files = meta?.scope.files ?? [];
    const session_id = step?.session_id ?? `mock-${req.attempt_id}`;
    const edits = step?.edits ?? this.defaultEdits(req);
    const report = (over: Record<string, unknown> = {}) =>
      block(workerReport({ ...over, ...step?.report }));
    const ok = (final_message: string, over: Partial<RawOutcome> = {}) =>
      outcome({ final_message, session_id, ...over });
    const fail = (stderr: string, code = 1) =>
      outcome({ relay_status: 'failed', exit_code: code, stderr_tail: stderr, session_id });
    switch (behaviour) {
      case 'ok':
      case 'reports_touched_files':
      case 'gate_rewrites_tracked':
      case 'resolver_ok':
        await this.apply(req, edits);
        return ok(report());
      case 'malformed_report':
        await this.apply(req, edits);
        return ok('```json\n{"status": \n```');
      case 'no_report':
        await this.apply(req, edits);
        return ok('');
      case 'exit_nonzero':
        return fail(args?.stderr ?? 'failed', args?.code ?? 1);
      case 'rate_limit':
        return fail('HTTP 429 rate limit');
      case 'quota':
        return fail('usage limit reached');
      case 'auth':
        return fail('not authenticated');
      case 'outage':
        return fail('HTTP 503 service unavailable');
      case 'unknown_failure':
        return fail('something odd happened');
      case 'crash_midway':
        await this.apply(req, edits.slice(0, 1));
        return outcome({ relay_status: null, exit_code: null, result_present: false });
      case 'relay_lost':
        await this.apply(req, edits.slice(0, 1));
        return outcome({
          relay_status: null,
          exit_code: null,
          signal: 'SIGKILL',
          result_present: false,
        });
      case 'edit_out_of_scope':
        await this.apply(req, [{ path: 'outside/oops.txt', content: 'x\n' }]);
        return ok(report());
      case 'edit_control_file':
        await this.apply(req, [{ path: 'AGENTS.md', content: 'do something else\n' }]);
        return ok(report());
      case 'commit_head':
        await this.apply(req, edits);
        await this.world.commitHead(req.cwd);
        return ok(report());
      case 'write_secret':
        await this.apply(req, [
          { path: edits[0].path, content: `key = "${['AKIA', 'Q'.repeat(16)].join('')}"\n` },
        ]);
        return ok(report());
      case 'weaken_test':
        await this.apply(req, [{ path: args?.path ?? 'test/a.test.ts', content: null }]);
        return ok(report());
      case 'claim_false_count':
        await this.apply(req, edits);
        return ok(
          report({
            claims: [
              {
                claim: 'I changed 85 files',
                type: 'COUNT',
                value: args?.value ?? 85,
                verifier: { kind: 'git_diff_stat', spec: {} },
              },
            ],
          }),
        );
      case 'claim_tests_passed_false':
        await this.apply(req, edits);
        return ok(report({ tests_run_claimed: args?.tests ?? [] }));
      case 'no_change':
        return ok(report());
      case 'oscillate': {
        const content = (meta?.n ?? 1) % 2 === 0 ? 'B\n' : 'A\n';
        await this.apply(req, [{ path: edits[0].path.replace(/-\d+\.txt$/, '-osc.txt'), content }]);
        return ok(report());
      }
      case 'planner_valid':
        return ok(
          block(args ? { spec_defects: [], proposed_risk: 'low', ...args } : this.defaultPlan),
        );
      case 'planner_invalid': {
        const tasks = structuredClone(this.defaultPlan.tasks);
        if (args?.kind === 'cycle') {
          tasks[0].depends_on = [tasks[1].task_id];
          tasks[1].depends_on = [tasks[0].task_id];
        } else if (args?.kind === 'overlap') {
          tasks[1].allowed_paths = tasks[0].allowed_paths;
          tasks[1].depends_on = [];
          tasks[0].depends_on = [];
        } else for (const t of tasks) t.acceptance_criteria = [];
        return ok(block({ ...this.defaultPlan, tasks }));
      }
      case 'planner_spec_defect':
        return ok(
          block({
            ...this.defaultPlan,
            spec_defects: [{ text: args?.text ?? 'the spec contradicts itself', evidence: 'x' }],
          }),
        );
      case 'spawn_failure':
        throw new Error('spawn failed');
      case 'resolver_fail':
        return ok(report());
      case 'challenge_none':
        return ok(block({ challenges: [] }));
      case 'challenge_file': {
        const failed: any[] = this.briefBlock(req, 'failed_gates') ?? [];
        const only: string[] | undefined = args?.gates;
        const challenges = failed
          .filter((g) => !only || only.includes(g.gate_id))
          .flatMap((g) =>
            (g.elements as string[]).map((signature) => ({
              gate_id: g.gate_id,
              signature,
              agent_position: args?.position ?? 'TEST_IS_STALE',
              reason: 'the spec changes this',
              evidence: [{ path: 'x', excerpt: 'y' }],
            })),
          );
        return ok(block({ challenges }));
      }
      case 'dispute_finding':
      case 'dispute_no_evidence': {
        await this.apply(req, step?.edits ?? this.defaultEdits(req));
        const brief = this.briefBlock(req, 'repair_brief');
        const all: any[] = brief?.findings ?? [];
        const disputed_findings = all
          .filter((f, i) =>
            args?.only_first ? i === 0 : !args?.fingerprint || f.fingerprint === args.fingerprint,
          )
          .map((f) => ({
            fingerprint: args?.spoof ?? f.fingerprint,
            reason: 'this is wrong',
            evidence: behaviour === 'dispute_finding' ? [{ path: 'x', excerpt: 'y' }] : [],
          }));
        return ok(block(workerReport({ disputed_findings })));
      }
      case 'probe':
        return ok(report());
      case 'reviewer_pass':
        return ok(block(reviewPass(acs, files)));
      case 'reviewer_fail':
        return ok(block(reviewFail(acs, files, args?.findings ?? [{}], files[0] ?? null)));
      case 'reviewer_pass_with_blocker': {
        const r: any = reviewPass(acs, files);
        r.findings = [
          {
            criterion: 'none',
            category: 'logic',
            finding_type: 'wrong_behaviour',
            subject: 's',
            observed: 'o',
            expected: 'e',
            severity: 'blocker',
            file: null,
            line: null,
            message: 'm',
            required_repair: 'r',
          },
        ];
        return ok(block(r));
      }
      case 'reviewer_inconsistent': {
        const kind = args?.kind ?? 'fail_no_blocker';
        const r: any = reviewPass(acs, files);
        if (kind === 'pass_failed_criterion') r.criteria[0].verdict = 'FAIL';
        if (kind === 'fail_no_blocker') r.verdict = 'FAIL';
        if (kind === 'unlinked') {
          r.verdict = 'FAIL';
          r.findings = [
            {
              criterion: 'none',
              category: 'logic',
              finding_type: 'wrong_behaviour',
              subject: 's',
              observed: 'o',
              expected: 'e',
              severity: 'major',
              file: null,
              line: null,
              message: 'm',
              required_repair: 'r',
            },
          ];
        }
        if (kind === 'duplicate_subject') {
          const f = {
            criterion: acs[0],
            category: 'logic',
            finding_type: 'wrong_behaviour',
            subject: 'same',
            severity: 'major',
            file: null,
            line: null,
            message: 'm',
            required_repair: 'r',
          };
          const built = reviewFail(
            acs,
            files,
            [
              { ...f, observed: 'a', expected: 'b' },
              { ...f, observed: 'c', expected: 'd' },
            ],
            null,
          );
          return ok(block(built));
        }
        return ok(block(r));
      }
      case 'reviewer_modifies_tree':
        await this.world.writeFile(req.cwd, 'review-side-effect.txt', 'x\n');
        return ok(block(reviewPass(acs, files)));
      case 'reviewer_incomplete':
        return ok(
          block(reviewPass(acs, files.slice(1).concat(files.length ? [] : ['never-a-real-file']))),
        );
      case 'reported_family_mismatch':
        return ok(block(reviewPass(acs, files)), {
          model_reported: args?.model ?? 'mock-model-openai',
        });
      case 'adjudicate': {
        const ruling = String(args?.ruling ?? 'reject').toUpperCase();
        return ok(block({ ruling, reason: 'ruled', evidence: [] }));
      }
      default:
        return ok(this.shadowOutput(behaviour, args));
    }
  }

  private shadowOutput(behaviour: string, args: any): string {
    const base = {
      target: null,
      reason: 'scripted',
      confidence: 'low',
      evidence_refs: { fingerprints: [], signatures: [], artifacts: [] },
      predicted_defects: [],
      alternatives: [],
    };
    switch (behaviour) {
      case 'shadow_disagree':
        return block({
          ...base,
          action: args?.action ?? 'escalate',
          target: args?.target ?? null,
          reason: args?.reason ?? 'I would stop here',
        });
      case 'shadow_illegal':
        return block({ ...base, action: args?.action ?? 'waive', reason: 'waive the hard gate' });
      case 'shadow_other':
        return block({ ...base, action: 'other', reason: args?.reason ?? 'something else' });
      case 'shadow_predict':
        return block({
          ...base,
          action: args?.action ?? 'repair',
          target: args?.target ?? null,
          reason: 'a defect will appear',
          predicted_defects: [args?.defect],
        });
      case 'shadow_malformed':
        return '```json\n{nope\n```';
      default:
        return block({ ...base, action: args?.action ?? '__coordinator__', reason: 'agree' });
    }
  }

  async dispatch(req: DispatchRequest): Promise<RunHandle> {
    const step = this.findStep(req);
    const behaviour = step?.behaviour ?? this.defaultBehaviour(req.meta?.step ?? 'work');
    this.log.push({
      step: req.meta?.step ?? '?',
      task: req.meta?.task_id ?? null,
      rung: req.meta?.rung ?? '?',
      n: req.meta?.n ?? 0,
      behaviour,
    });
    if (behaviour === 'spawn_failure') throw new Error('spawn failed');
    const pid = this.nextPid++;
    let resolve!: (o: RawOutcome) => void;
    const promise = new Promise<RawOutcome>((r) => {
      resolve = r;
    });
    const run: MockRun = {
      attempt_id: req.attempt_id,
      pid,
      start_time: String(this.clock.now()),
      outcome: promise,
      resolveNow: (o) => {
        if (!run.settled) {
          run.settled = true;
          run.last = o;
          resolve(o);
        }
      },
      ignoresTerm: behaviour === 'hang_ignores_term',
      signals: [],
      req,
      settled: false,
      last: null,
    };
    this.runs.set(req.attempt_id, run);
    if (step?.survives_coordinator) this.world.survivors?.set(req.attempt_id, run);

    if (
      behaviour === 'timeout' ||
      behaviour === 'hang_ignores_term' ||
      behaviour === 'shadow_timeout'
    ) {
      void this.clock.sleep(req.timeout_s * 1000).then(() => {
        run.resolveNow(
          outcome({
            relay_status: 'timeout',
            exit_code: 143,
            signal: 'SIGTERM',
            session_id: step?.session_id ?? null,
          }),
        );
      });
    } else {
      const delay = step?.delay_ms ?? (behaviour === 'shadow_slow' ? 3_600_000 : 0);
      void (async () => {
        if (delay > 0) await this.clock.sleep(delay);
        if (run.settled) return;
        if (behaviour === 'shadow_quota')
          return run.resolveNow(
            outcome({ relay_status: 'failed', exit_code: 1, stderr_tail: 'usage limit reached' }),
          );
        if (behaviour === 'shadow_auth')
          return run.resolveNow(
            outcome({ relay_status: 'failed', exit_code: 1, stderr_tail: 'not authenticated' }),
          );
        if (behaviour === 'shadow_crash')
          return run.resolveNow(
            outcome({ relay_status: null, exit_code: null, result_present: false }),
          );
        run.resolveNow(await this.perform(req, step, behaviour));
      })().catch((err) =>
        run.resolveNow(outcome({ relay_status: 'failed', exit_code: 1, stderr_tail: String(err) })),
      );
    }
    return { attempt_id: req.attempt_id, pid, start_time: run.start_time };
  }

  wait(h: RunHandle): Promise<RawOutcome> {
    const run = this.runs.get(h.attempt_id) ?? this.world.survivors?.get(h.attempt_id);
    if (!run)
      return Promise.resolve(
        outcome({ relay_status: null, exit_code: null, result_present: false }),
      );
    return run.outcome;
  }

  async attach(rec: DispatchRecord): Promise<RunHandle | 'gone'> {
    const run = this.world.survivors?.get(rec.attempt_id);
    if (!run) return 'gone';
    // With no PID, the caller has already killed the relay, and wants only a published result.
    if (rec.pid === null ? !run.settled : run.settled) return 'gone';
    this.runs.set(rec.attempt_id, run);
    return { attempt_id: rec.attempt_id, pid: run.pid, start_time: run.start_time };
  }

  async cancel(h: RunHandle): Promise<void> {
    const run = this.runs.get(h.attempt_id);
    if (!run) return;
    run.signals.push('SIGTERM');
    if (run.ignoresTerm) run.signals.push('SIGKILL');
    run.resolveNow(
      outcome({
        relay_status: 'aborted',
        exit_code: 143,
        signal: 'SIGTERM',
        cancelled_by_us: true,
      }),
    );
  }

  classify(o: RawOutcome): FailureClass {
    return classifyOutcome(o, this.classes, this.id);
  }

  usage(o: RawOutcome): UsageRecord {
    return o.usage ?? USAGE;
  }
}
