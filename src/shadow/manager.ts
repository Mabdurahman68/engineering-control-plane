import type {
  DecisionObserver,
  DecisionRecord,
  RawOutcome,
  ShadowProposal,
  UsageRecord,
  WorkerAdapter,
} from '../contracts/index.ts';
import { shadowReportSchema } from '../contracts/index.ts';
import { assemble } from '../core/briefs.ts';
import { RUN_TERMINAL } from '../core/tables.ts';
import type { Engine } from '../core/engine.ts';
import { canonical, sha256 } from '../ledger/canonical.ts';
import { loadLedger } from '../ledger/ledger.ts';
import { parseBlock } from '../review/report-block.ts';
import { compareProposal } from './compare.ts';
import { observedOutcome, ownerPreference } from './outcome.ts';

type Pending = {
  rec: DecisionRecord;
  attempt_id: string;
  rung: string;
  family: string;
  relation: 'different' | 'same_family_different_model';
  adapter: WorkerAdapter;
  input_sha: string;
  raw: RawOutcome | null;
  deadline: number;
  startedMs: number;
};

const UNAVAILABLE_USAGE: UsageRecord = {
  source: 'unavailable',
  tokens: 'unavailable',
  cost_usd: 'unavailable',
  quota_snapshot: 'unavailable',
  wall_clock_s: 0,
};

export type ShadowOptions = {
  // An empty directory per proposal, so the run folder isn't its working directory.
  scratchDir(decisionId: string): string;
  transport: 'mock' | 'fake_cli' | 'real';
};

// One way: it reads run state and records. Nothing it does reaches a transition or worker state.
export class ShadowManager implements DecisionObserver {
  private readonly engine: () => Engine;
  private readonly o: ShadowOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly proposals = new Map<string, ShadowProposal>();
  // Its own memory of a limited rung. It never touches worker quarantine or backoff.
  private readonly skipUntil = new Map<string, number>();
  private count = 0;

  constructor(engine: () => Engine, o: ShadowOptions) {
    this.engine = engine;
    this.o = o;
  }

  private chooseRung(
    e: Engine,
    rec: DecisionRecord,
  ): { rung: string; relation: Pending['relation'] } | null {
    const policy = e.p.policy;
    const task = rec.task_id ? e.s.tasks[rec.task_id] : null;
    const writers = task ? [task.rung ? e.family(task.rung) : null] : e.authorsIntegrated();
    const judged = task?.rung ? e.rung(task.rung)?.model : null;
    const usable = (r: string) => {
      const until = this.skipUntil.get(r);
      if (until !== undefined && until > e.now()) return false;
      return e.rungAvailable(r) && e.rung(r)?.model !== judged;
    };
    const ladder = policy.workers.ladders.shadow;
    for (const r of ladder) {
      if (usable(r) && !writers.includes(e.family(r))) return { rung: r, relation: 'different' };
    }
    for (const r of ladder) {
      if (usable(r)) return { rung: r, relation: 'same_family_different_model' };
    }
    return null;
  }

  private overBudget(e: Engine): boolean {
    const c = e.p.policy.settings.caps;
    const day = e.p.dayUsage();
    return (
      e.s.counters.shadow_invocations >= c.run.shadow_invocations ||
      day.shadow_invocations + e.s.counters.shadow_invocations >= c.day.shadow_invocations
    );
  }

  private recordNone(
    rec: DecisionRecord,
    status: 'SHADOW_UNAVAILABLE' | 'SHADOW_SKIPPED_BUDGET',
    cls: string,
  ) {
    const e = this.engine();
    const input_sha = sha256(canonical(rec.bundle));
    e.p.store.write(`shadow/${rec.decision_id}-input.json`, JSON.stringify(rec.bundle, null, 2));
    this.write(this.proposalFor(rec, input_sha, null, status, cls, null, UNAVAILABLE_USAGE));
    e.append('shadow.unavailable', rec.task_id, {
      decision_id: rec.decision_id,
      status,
      class: cls,
    });
  }

  onDecision(rec: DecisionRecord): void {
    const e = this.engine();
    if (this.overBudget(e)) {
      this.recordNone(rec, 'SHADOW_SKIPPED_BUDGET', 'budget');
      return;
    }
    const chosen = this.chooseRung(e, rec);
    if (!chosen) {
      this.recordNone(rec, 'SHADOW_UNAVAILABLE', 'no_rung');
      return;
    }
    const input_sha = sha256(canonical(rec.bundle));
    e.p.store.write(`shadow/${rec.decision_id}-input.json`, JSON.stringify(rec.bundle, null, 2));
    const brief = assemble(e.p.prompts.shadow ?? '', [
      ['decision_point', rec.point],
      ['bundle', rec.bundle],
    ]);
    const attempt_id = `S-${String(++this.count).padStart(4, '0')}-${rec.decision_id}-${e.now()}`;
    const rel = `shadow/attempts/${attempt_id}`;
    e.p.store.write(`${rel}/brief.txt`, brief);
    const timeout = e.p.policy.settings.timeouts.shadow_s;
    const rung = e.rung(chosen.rung);
    const adapter = e.p.adapters[rung.adapter];
    e.append('shadow.intent', rec.task_id, {
      decision_id: rec.decision_id,
      attempt_id,
      rung: chosen.rung,
      input_sha,
      out_dir: e.p.store.path(rel),
    });
    const p: Pending = {
      rec,
      attempt_id,
      rung: chosen.rung,
      family: e.family(chosen.rung),
      relation: chosen.relation,
      adapter,
      input_sha,
      raw: null,
      deadline: e.now() + timeout * 1000,
      startedMs: e.now(),
    };
    this.pending.set(rec.decision_id, p);
    const req = {
      attempt_id,
      brief_path: `${e.p.store.path(rel)}/brief.txt`,
      cwd: this.o.scratchDir(rec.decision_id),
      out_dir: e.p.store.path(rel),
      model: rung.model,
      effort: rung.effort ?? rung.variant ?? null,
      mode: 'read_only' as const,
      timeout_s: timeout,
      session_id: null,
      env_allowlist: rung.credential_env,
      meta: {
        task_id: rec.task_id,
        step: 'shadow',
        n: Number(rec.decision_id.slice(3)),
        rung: chosen.rung,
        allowed_paths: [],
        scope: { acs: [], files: [] },
        point: rec.point,
      },
    };
    // Background, by design: the coordinator never waits on this.
    void adapter
      .dispatch(req)
      .then((h) => adapter.wait(h))
      .then(
        (raw) => {
          p.raw = raw;
        },
        (err) => {
          p.raw = {
            relay_status: 'failed',
            exit_code: 1,
            signal: null,
            final_message: '',
            stderr_tail: String(err),
            session_id: null,
            model_reported: null,
            usage: null,
            result_present: true,
            transport_provenance: 'mock',
            cancelled_by_us: false,
          };
        },
      );
  }

  poll(): void {
    const e = this.engine();
    for (const [id, p] of [...this.pending]) {
      if (p.raw) {
        this.pending.delete(id);
        this.finish(p, p.raw);
      } else if (e.now() >= p.deadline) {
        this.pending.delete(id);
        this.unavailable(p, 'TIMEOUT');
      }
    }
  }

  nextWake(): number | null {
    let wake: number | null = null;
    for (const p of this.pending.values())
      if (wake === null || p.deadline < wake) wake = p.deadline;
    return wake;
  }

  private unavailable(p: Pending, cls: string) {
    const e = this.engine();
    this.write(
      this.proposalFor(p.rec, p.input_sha, p, 'SHADOW_UNAVAILABLE', cls, null, UNAVAILABLE_USAGE),
    );
    e.append('shadow.unavailable', p.rec.task_id, {
      decision_id: p.rec.decision_id,
      status: 'SHADOW_UNAVAILABLE',
      class: cls,
    });
  }

  private finish(p: Pending, raw: RawOutcome) {
    const e = this.engine();
    const cls = raw.spawn_failed ? 'UNKNOWN' : p.adapter.classify(raw);
    if (cls !== 'OK') {
      // Only the shadow's own memory changes. The worker finds out for itself on its next dispatch.
      if (cls === 'QUOTA' || cls === 'RATE_LIMIT' || cls === 'AUTH')
        this.skipUntil.set(p.rung, e.now() + 3_600_000);
      return this.unavailable(p, cls);
    }
    const parsed = parseBlock(raw.final_message, shadowReportSchema);
    if (!parsed.ok) return this.unavailable(p, 'MALFORMED');
    const usage = p.adapter.usage(raw);
    const proposal = this.proposalFor(
      p.rec,
      p.input_sha,
      p,
      'RECORDED',
      null,
      parsed.value,
      usage,
      raw,
    );
    this.write(proposal);
    e.append('shadow.recorded', p.rec.task_id, {
      decision_id: p.rec.decision_id,
      match: proposal.comparison.match,
      legal: proposal.comparison.proposal_legal,
      action: parsed.value.action,
      reason: parsed.value.reason.slice(0, 200),
      point: p.rec.point,
      mock: proposal.shadow.mock,
      usage,
    });
  }

  private proposalFor(
    rec: DecisionRecord,
    input_sha: string,
    p: Pending | null,
    status: ShadowProposal['shadow']['status'],
    cls: string | null,
    report: ShadowProposal['shadow']['report'],
    usage: UsageRecord,
    raw?: RawOutcome,
  ): ShadowProposal {
    const e = this.engine();
    const coordinator = {
      action: rec.action as never,
      target: rec.target,
      transition: rec.transition,
      refs: rec.refs,
    };
    const task = rec.task_id ? e.s.tasks[rec.task_id] : null;
    const bundleGates = ((rec.bundle as any).gate_results?.results ?? []) as any[];
    const failedHardGates = bundleGates
      .filter((r) => r.status === 'FAIL' && !r.soft)
      .map((r) => r.id);
    const compared = report
      ? compareProposal(report, coordinator as never, {
          failedHardGates,
          reviewed: Boolean(task?.reviews.length),
        })
      : null;
    return {
      schema: 'shadow_proposal.v1',
      decision_id: rec.decision_id,
      point: rec.point as never,
      task_id: rec.task_id,
      risk: rec.risk as never,
      input_sha,
      subject_tree: rec.subject_tree,
      coordinator,
      shadow: {
        status,
        unavailable_class: cls,
        rung_id: p?.rung ?? null,
        model_requested: p ? (e.rung(p.rung)?.model ?? null) : null,
        model_reported: raw?.model_reported ?? null,
        family: p?.family ?? null,
        family_relation: p?.relation ?? null,
        session_id: raw?.session_id ?? null,
        report,
        mock: this.o.transport !== 'real',
      },
      comparison: compared ?? {
        match: null,
        match_rule: 'action_only',
        proposal_legal: null,
        would_violate: [],
      },
      outcome: {
        observed: { predictions: [], horizon_reached: false, label: 'UNDETERMINED', rule: null },
        owner_preference: {
          decision_id: null,
          option_id: null,
          aligned_with: null,
          new_information: null,
          authority_exercised: null,
        },
        counterfactual: { status: 'NOT_TESTED', replay_id: null },
      },
      usage,
    };
  }

  private write(p: ShadowProposal) {
    this.proposals.set(p.decision_id, p);
    this.engine().p.store.write(`shadow/${p.decision_id}.json`, JSON.stringify(p, null, 2));
  }

  // A shadow.intent with no outcome: the one rule for its processes, then one re-dispatch from the
  // frozen bundle, then unavailable. Steering isn't affected either way.
  async onResume(): Promise<void> {
    const e = this.engine();
    const events = loadLedger(e.p.ledgerStore).events;
    const settled = new Set(
      events
        .filter((ev) => ev.type === 'shadow.recorded' || ev.type === 'shadow.unavailable')
        .map((ev) => ev.data.decision_id as string),
    );
    const intents = events.filter((ev) => ev.type === 'shadow.intent');
    const open = [...new Set(intents.map((ev) => ev.data.decision_id as string))].filter(
      (id) => !settled.has(id),
    );
    for (const id of open) {
      // Still running in this process, after a pause rather than a crash.
      if (this.pending.has(id)) continue;
      const mine = intents.filter((ev) => ev.data.decision_id === id);
      const last = mine[mine.length - 1];
      const found = await e.p.scanner.scan({
        attempt_id: last.data.attempt_id as string,
        out_dir: last.data.out_dir as string,
        cwd: this.o.scratchDir(id),
      });
      if (found.length)
        await e.p.killer.kill(
          found.map((x) => x.pid),
          'SIGKILL',
        );
      const made = events.find((ev) => ev.type === 'decision.made' && ev.data.decision_id === id);
      const bundleText = e.p.store.read(`shadow/${id}-input.json`);
      const rec: DecisionRecord | null =
        made && bundleText
          ? {
              decision_id: id,
              point: made.data.point as string,
              task_id: made.task_id,
              risk: made.data.risk as string,
              subject_tree: (made.data.subject_tree as string) ?? null,
              action: made.data.action as string,
              target: (made.data.target as string) ?? null,
              transition: made.data.transition as never,
              refs: made.data.refs as never,
              bundle: JSON.parse(bundleText),
            }
          : null;
      if (rec && mine.length < 2) this.onDecision(rec);
      else
        e.append('shadow.unavailable', last.task_id, {
          decision_id: id,
          status: 'SHADOW_UNAVAILABLE',
          class: 'LOST',
        });
    }
  }

  // Before RUN_REPORT: wait, for at most the end-of-run limit, then mark the rest unavailable.
  async drain(): Promise<void> {
    const e = this.engine();
    const limit = e.now() + e.p.policy.settings.timeouts.shadow_end_wait_s * 1000;
    while (this.pending.size > 0 && e.now() < limit) {
      this.poll();
      if (this.pending.size === 0) break;
      await e.p.clock.idle(
        limit,
        () => [...this.pending.values()].some((p) => p.raw !== null),
        () => {},
      );
    }
    this.poll();
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      this.unavailable(p, 'END_OF_RUN');
    }
    this.resolveOutcomes();
  }

  // Filled once the run has shown what it can. A model never scores itself.
  resolveOutcomes() {
    const e = this.engine();
    const events = loadLedger(e.p.ledgerStore).events;
    const recorded = events
      .filter((ev) => ev.type === 'shadow.recorded')
      .map((ev) => ev.data.decision_id as string);
    for (const id of recorded) {
      const stored = e.p.store.read(`shadow/${id}.json`);
      if (!stored) continue;
      const proposal: ShadowProposal = this.proposals.get(id) ?? JSON.parse(stored);
      if (proposal.shadow.status !== 'RECORDED' || !proposal.shadow.report) continue;
      if (
        events.some(
          (ev) =>
            ev.type === 'shadow.outcome_resolved' &&
            ev.data.decision_id === id &&
            ev.data.final === true,
        )
      )
        continue;
      const at = events.find(
        (ev) => ev.type === 'decision.made' && ev.data.decision_id === proposal.decision_id,
      );
      const after = at ? events.filter((ev) => ev.seq > at.seq) : [];
      const legal = proposal.comparison.proposal_legal === true;
      proposal.outcome.observed = observedOutcome(
        proposal.coordinator.action,
        proposal.shadow.report,
        legal,
        proposal.task_id,
        after,
      );
      const dec = after.find(
        (ev) =>
          ev.type === 'operator.decision' &&
          (ev.task_id === proposal.task_id || proposal.task_id === null),
      );
      proposal.outcome.owner_preference = ownerPreference(
        proposal.coordinator.action,
        proposal.shadow.report.action,
        (dec?.data as Record<string, any>) ?? null,
      );
      this.write(proposal);
      e.append('shadow.outcome_resolved', proposal.task_id, {
        decision_id: proposal.decision_id,
        label: proposal.outcome.observed.label,
        rule: proposal.outcome.observed.rule,
        predictions: proposal.outcome.observed.predictions,
        aligned_with: proposal.outcome.owner_preference.aligned_with,
        new_information: proposal.outcome.owner_preference.new_information,
        final: ['READY_FOR_HUMAN_MERGE', 'PUSH_BLOCKED', ...RUN_TERMINAL].includes(e.s.state),
      });
    }
  }
}
