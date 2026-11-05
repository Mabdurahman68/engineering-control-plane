import type { LedgerEvent } from '../contracts/index.ts';

// Every figure a report shows comes from here, computed from the ledger. Never from model text.
export type Figures = {
  gates: { passed: number; total: number; failed: string[] };
  waivers: {
    id: string;
    gate: string | null;
    fingerprint: string | null;
    scope: string;
    tree: string;
  }[];
  disagreements: { id: string; kind: string; status: string; adjudicator: string | null }[];
  claims: {
    verified: number;
    corrected: number;
    rejected: number;
    unverified: number;
    corrections: { claim: string; observed: unknown }[];
  };
  fallbacks: { from: string; to: string; class: string }[];
  repairs: { total: number; byTask: Record<string, number> };
  usage: {
    total: number;
    measured: number;
    tokens: number;
    cost_usd: number;
    cost_measured: number;
  };
  worker_wall_s: number;
  interventions: number;
  invocations: number;
  not_examined: { store: string; reason: string }[];
  waiver_void: { fingerprint: string; cause: string }[];
  who: { task: string | null; step: string; rung: string; family: string }[];
  shadow: ShadowFigures;
};

export type ShadowFigures = {
  decision_points: number;
  recorded: number;
  unavailable: number;
  skipped: number;
  matched: number;
  illegal: number;
  disagreements: number;
  labels: { coordinator: number; shadow: number; undetermined: number };
  owner: { coordinator: number; shadow: number; neither: number; new_information: number };
  byPoint: Record<
    string,
    { matched: number; recorded: number; unavailable: number; skipped: number }
  >;
  byRisk: Record<
    string,
    { matched: number; recorded: number; unavailable: number; skipped: number }
  >;
  byModel: Record<string, { matched: number; recorded: number }>;
  replayed: number;
  mock: boolean;
};

export function computeFigures(
  events: LedgerEvent[],
  rungModel: (rung: string) => string = (r) => r,
): Figures {
  const f: Figures = {
    gates: { passed: 0, total: 0, failed: [] },
    waivers: [],
    disagreements: [],
    claims: { verified: 0, corrected: 0, rejected: 0, unverified: 0, corrections: [] },
    fallbacks: [],
    repairs: { total: 0, byTask: {} },
    usage: { total: 0, measured: 0, tokens: 0, cost_usd: 0, cost_measured: 0 },
    worker_wall_s: 0,
    interventions: 0,
    invocations: 0,
    not_examined: [],
    waiver_void: [],
    who: [],
    shadow: {
      decision_points: 0,
      recorded: 0,
      unavailable: 0,
      skipped: 0,
      matched: 0,
      illegal: 0,
      disagreements: 0,
      labels: { coordinator: 0, shadow: 0, undetermined: 0 },
      owner: { coordinator: 0, shadow: 0, neither: 0, new_information: 0 },
      byPoint: {},
      byRisk: {},
      byModel: {},
      replayed: 0,
      mock: false,
    },
  };
  const disagreement = new Map<string, Figures['disagreements'][number]>();
  const decisions = new Map<string, { point: string; risk: string }>();
  const shadowRung = new Map<string, string>();
  const outcome = new Map<string, Record<string, any>>();
  const bump = (m: Record<string, any>, k: string, field: string) => {
    m[k] = m[k] ?? { matched: 0, recorded: 0, unavailable: 0, skipped: 0 };
    m[k][field] += 1;
  };
  for (const e of events) {
    const d = e.data as Record<string, any>;
    switch (e.type) {
      case 'gate.finished':
        for (const r of (d.results ?? []) as any[]) {
          if (String(r.id).startsWith('test-')) continue;
          f.gates.total += 1;
          if (r.status === 'FAIL') f.gates.failed.push(r.id);
          else f.gates.passed += 1;
        }
        break;
      case 'waiver.recorded':
        f.waivers.push({
          id: d.waiver.id,
          gate: d.waiver.resolves.gate_id,
          fingerprint: d.waiver.resolves.finding_fingerprint,
          scope: d.waiver.scope,
          tree: d.waiver.tree_at_ruling,
        });
        break;
      case 'disagreement.opened':
        disagreement.set(d.record.id, {
          id: d.record.id,
          kind: d.record.kind,
          status: d.record.adjudication.status,
          adjudicator: d.record.adjudication.adjudicator,
        });
        break;
      case 'disagreement.adjudicated': {
        const rec = disagreement.get(d.id);
        if (rec) {
          rec.status = d.adjudication.status;
          rec.adjudicator = d.adjudication.adjudicator;
        }
        break;
      }
      case 'claim.recorded': {
        const c = d.claim;
        if (c.final === 'VERIFIED') f.claims.verified += 1;
        else if (c.final === 'CORRECTED') f.claims.corrected += 1;
        else if (c.final === 'REJECTED') f.claims.rejected += 1;
        else f.claims.unverified += 1;
        if (c.mechanical.status === 'CONTRADICTED')
          f.claims.corrections.push({ claim: c.claim, observed: c.mechanical.observed });
        break;
      }
      case 'fallback.taken':
        f.fallbacks.push({ from: d.from, to: d.to, class: d.class });
        break;
      case 'repair.requested':
        f.repairs.total += 1;
        f.repairs.byTask[e.task_id as string] = (f.repairs.byTask[e.task_id as string] ?? 0) + 1;
        break;
      case 'usage.recorded':
        f.usage.total += 1;
        if (d.tokens && d.tokens !== 'unavailable') {
          f.usage.measured += 1;
          f.usage.tokens += d.tokens.input + d.tokens.output;
        }
        if (typeof d.cost_usd === 'number') {
          f.usage.cost_measured += 1;
          f.usage.cost_usd += d.cost_usd;
        }
        break;
      case 'dispatch.finished':
        if (typeof d.wall_clock_s === 'number') f.worker_wall_s += d.wall_clock_s;
        break;
      case 'operator.decision':
        f.interventions += 1;
        break;
      case 'dispatch.intent':
      case 'plan.intent':
      case 'review.intent':
        f.invocations += 1;
        f.who.push({ task: e.task_id, step: d.step, rung: d.rung, family: d.family });
        break;
      case 'review.collected':
        for (const n of (d.not_examined ?? []) as any[]) f.not_examined.push(n);
        for (const v of (d.waiver_void ?? []) as any[]) f.waiver_void.push(v);
        break;
      case 'decision.made':
        f.shadow.decision_points += 1;
        decisions.set(d.decision_id, { point: d.point, risk: d.risk });
        break;
      case 'shadow.intent':
        shadowRung.set(d.decision_id, d.rung);
        break;
      case 'shadow.recorded': {
        const dec = decisions.get(d.decision_id);
        f.shadow.recorded += 1;
        if (d.mock) f.shadow.mock = true;
        if (d.match) f.shadow.matched += 1;
        else f.shadow.disagreements += 1;
        if (d.legal === false) f.shadow.illegal += 1;
        const model = rungModel(shadowRung.get(d.decision_id) ?? 'unknown');
        f.shadow.byModel[model] = f.shadow.byModel[model] ?? { matched: 0, recorded: 0 };
        f.shadow.byModel[model].recorded += 1;
        if (d.match) f.shadow.byModel[model].matched += 1;
        if (dec) {
          bump(f.shadow.byPoint, dec.point, 'recorded');
          bump(f.shadow.byRisk, dec.risk, 'recorded');
          if (d.match) {
            bump(f.shadow.byPoint, dec.point, 'matched');
            bump(f.shadow.byRisk, dec.risk, 'matched');
          }
        }
        break;
      }
      case 'shadow.unavailable': {
        if (!d.decision_id) break;
        const dec = decisions.get(d.decision_id);
        const field = d.status === 'SHADOW_SKIPPED_BUDGET' ? 'skipped' : 'unavailable';
        if (field === 'skipped') f.shadow.skipped += 1;
        else f.shadow.unavailable += 1;
        if (dec) {
          bump(f.shadow.byPoint, dec.point, field);
          bump(f.shadow.byRisk, dec.risk, field);
        }
        break;
      }
      case 'shadow.outcome_resolved':
        // The last resolution per decision is the one that counts.
        outcome.set(d.decision_id, d);
        break;
      default:
        break;
    }
  }
  f.disagreements = [...disagreement.values()];
  for (const o of outcome.values()) {
    if (o.label === 'CONSISTENT_WITH_COORDINATOR') f.shadow.labels.coordinator += 1;
    else if (o.label === 'CONSISTENT_WITH_SHADOW') f.shadow.labels.shadow += 1;
    else f.shadow.labels.undetermined += 1;
    if (o.aligned_with === 'coordinator') f.shadow.owner.coordinator += 1;
    if (o.aligned_with === 'shadow') f.shadow.owner.shadow += 1;
    if (o.aligned_with === 'neither') f.shadow.owner.neither += 1;
    if (o.new_information === true) f.shadow.owner.new_information += 1;
  }
  return f;
}
