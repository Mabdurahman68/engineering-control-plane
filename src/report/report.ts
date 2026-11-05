import type { LedgerEvent, ShadowProposal, Spec } from '../contracts/index.ts';
import type { RunR } from '../core/reducer.ts';
import { computeFigures } from './figures.ts';

export type ReportInput = {
  runId: string;
  spec: Spec;
  state: RunR;
  events: LedgerEvent[];
  proposals: ShadowProposal[];
  rungModel: (rung: string) => string;
  visibility?: string;
  pushAccount?: string | null;
  pushScopes?: string | null;
};

const short = (s: string | null) => (s ? s.slice(0, 7) : 'none');
const hhmm = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function firstLine(i: ReportInput): string {
  const s = i.state;
  switch (s.state) {
    case 'MOCK_RUN_COMPLETE':
      return 'MOCK RUN — orchestration only; no semantic approval was given';
    case 'READY_FOR_HUMAN_MERGE':
      return 'Verified candidate, ready for you to merge.';
    case 'PR_OPENED':
      return 'Verified candidate, pushed as a draft pull request.';
    case 'PUSH_BLOCKED':
      return `Verified candidate, not pushed: ${trim(s.publish.last_error ?? 'push gate failed', 45)}`;
    case 'ESCALATION_REQUIRED':
      return `Needs your decision: ${trim(s.reason ?? '', 50)}`;
    case 'PAUSED_NO_WORKER':
      return `Paused, no worker: ${trim(s.reason ?? '', 55)}`;
    case 'PAUSED_BUDGET':
      return 'Paused: a spend cap was reached.';
    case 'PAUSED_OPERATOR':
      return 'Paused by you.';
    case 'FAILED':
      return `Failed: ${trim(s.reason ?? 'see the ledger', 65)}`;
    case 'CANCELLED':
      return `Cancelled: ${trim(s.reason ?? '', 60)}`;
    default:
      return `In progress: ${s.state}`;
  }
}

function acLines(i: ReportInput): string[] {
  const s = i.state;
  return i.spec.acceptance_criteria.map((c) => {
    const owner = s.human_verified.includes(c.id);
    if (owner) return `- ${c.id} OWNER — you verified it; the system didn't`;
    if (c.human_reserved) return `- ${c.id} RESERVED — only you can verify this`;
    const commands = c.verify.filter((v) => v.kind === 'command').length;
    const semantic = c.verify.filter((v) => v.kind === 'semantic').length;
    const cmdOk = commands === 0 || s.verify.ac_evidence[c.id] === 'PASS';
    const semOk = semantic === 0 || s.verify.accepted.includes(c.id);
    if (cmdOk && semOk) {
      const how = [commands ? 'command exit 0' : null, semantic ? 'reviewed' : null]
        .filter(Boolean)
        .join(', ');
      return `- ${c.id} PASS — ${how}`;
    }
    if (s.verify.ac_evidence[c.id] === 'FAIL') return `- ${c.id} FAIL — command failed`;
    return `- ${c.id} NOT VERIFIED`;
  });
}

function shadowSection(i: ReportInput, f: ReturnType<typeof computeFigures>): string[] {
  const h = f.shadow;
  const stratum = (m: Record<string, { matched: number; recorded: number }>) =>
    Object.keys(m)
      .sort()
      .map((k) => `${k} ${m[k].matched}/${m[k].recorded}`)
      .join('; ') || 'none';
  const out = [
    `## Shadow orchestrator (recorded, never executed)${h.mock ? ' — MOCK' : ''}`,
    `Decision points: ${h.decision_points}   Recorded: ${h.recorded}`,
    `Unavailable: ${h.unavailable}   Skipped: ${h.skipped}`,
    `Agreement among recorded: ${h.matched}/${h.recorded}`,
    `Would have broken a rule: ${h.illegal}`,
    `Observed later: consistent with coordinator ${h.labels.coordinator},`,
    `  with shadow ${h.labels.shadow}, undetermined ${h.labels.undetermined}`,
    `Owner preference: matched coordinator ${h.owner.coordinator}, shadow ${h.owner.shadow},`,
    `  neither ${h.owner.neither}, new information ${h.owner.new_information}`,
    `Replayed: ${h.replayed} of ${h.disagreements} disagreements`,
    `By point: ${stratum(h.byPoint)}`,
    `By risk: ${stratum(h.byRisk)}`,
    `By shadow model: ${stratum(h.byModel)}`,
  ];
  // Every disagreement gets an entry, as the owner's ruling requires.
  for (const p of i.proposals) {
    if (p.shadow.status !== 'RECORDED' || !p.shadow.report || p.comparison.match) continue;
    const r = p.shadow.report;
    out.push(`- ${p.decision_id} ${p.point} ${p.task_id ?? 'run'}`);
    out.push(`  Coordinator: ${p.coordinator.action}`);
    out.push(`  Shadow: ${r.action} (${p.shadow.family ?? 'unknown'})`);
    out.push(`  Why: "${trim(r.reason.replace(/\s+/g, ' '), 60)}"`);
    for (const [n, d] of r.predicted_defects.entries()) {
      const label =
        d.kind === 'finding' ? `${d.finding_type} in ${d.subject}` : `${d.gate_id} fails`;
      const seen = p.outcome.observed.predictions[n];
      out.push(`  Predicted: ${trim(label, 50)}, by ${d.horizon}`);
      if (seen) {
        const at = seen.matched.evidence_seq;
        out.push(
          `  Observed: ${seen.status}${at !== null ? ` at seq ${at}` : ''} (not a counterfactual)`,
        );
      }
    }
    if (p.comparison.proposal_legal === false)
      out.push(`  Illegal: ${trim(p.comparison.would_violate.join(', '), 60)}`);
  }
  out.push("Agreement alone can't justify steering in v0.2.");
  return out;
}

export function renderReport(i: ReportInput): string {
  const s = i.state;
  const f = computeFigures(i.events, i.rungModel);
  const needsDecision = s.state === 'ESCALATION_REQUIRED';
  const tip = s.integration.tip;
  const first = i.events[0]?.at ? Date.parse(i.events[0].at) : 0;
  const last = i.events.at(-1)?.at ? Date.parse(i.events.at(-1)?.at as string) : first;
  const pub = i.spec.publish;
  const pushed = s.publish.verified;
  const out: string[] = [
    `# ${i.spec.spec_id} — ${s.state}`,
    firstLine(i),
    `Decision needed: ${needsDecision ? 'yes' : 'no'}`,
    '',
    '## Result',
    `Branch: ecp/${i.runId}/integration`,
    `Commit: ${short(tip)}`,
    `Base: ${short(i.spec.target.base_commit)}`,
    `See diff: git diff ${short(i.spec.target.base_commit)}..${short(tip)}`,
    `Pushed: ${pushed ? `yes, to ${pub?.repo}` : `no: ${pub ? (s.publish.last_error ?? 'not yet') : 'no publish block'}`}`,
    `Draft PR: ${s.publish.pr_url ?? 'none'}`,
  ];
  if (pub) {
    const visibility = (i.visibility ?? pub.visibility_expected).toUpperCase();
    out.push(
      `Visibility: ${visibility}. Anyone can see this branch and PR`.replace(
        'PRIVATE. Anyone can see this branch and PR',
        'PRIVATE',
      ),
    );
    out.push(
      `Push gate: secret, names, files, tree, branch, base: ${s.publish.gate_ok ? 'ok' : 'not passed'}`,
    );
    if (pushed) {
      out.push(`Pushed commit: ${s.publish.frozen_sha}; verified on remote: yes`);
      out.push(
        `Push login: GitHub CLI, ${i.pushAccount ?? 'unknown'}; scopes ${i.pushScopes ?? 'unknown'}`,
      );
    }
  }
  out.push('Merged: no. Merging is yours');
  if (s.state.startsWith('PAUSED_')) {
    out.push('', '## What clears this');
    if (s.state === 'PAUSED_BUDGET')
      out.push('Raise the cap, or use --extend-budget, or wait for a new day');
    else if (s.state === 'PAUSED_NO_WORKER')
      out.push('Fix the worker, or wait for its reset, or add a family');
    else out.push('Resume it, when you are ready');
    out.push(`Resume: ecp resume ${i.runId}`);
  }
  const acs = acLines(i);
  const passed = acs.filter((a) => / (PASS|OWNER|RESERVED) /.test(a)).length;
  out.push('', `## Acceptance criteria (${passed}/${acs.length})`, ...acs);
  out.push(
    '',
    '## Checks',
    `Gates: ${f.gates.passed}/${f.gates.total}${f.gates.failed.length ? ` (failed: ${[...new Set(f.gates.failed)].join(', ')})` : ''}`,
  );
  out.push(`Waivers: ${f.waivers.length}`);
  for (const w of f.waivers) out.push(`- ${w.gate ?? 'finding'} on ${w.scope}`);
  if (s.risk === 'high' && f.waivers.length) out.push('High risk: waivers above need your eye');
  out.push(`Disagreements: ${f.disagreements.length}`);
  for (const d of f.disagreements) out.push(`- ${d.id} ${d.kind} → ${d.status}`);
  out.push(
    `Claims: ${f.claims.verified} verified, ${f.claims.corrected} corrected, ${f.claims.rejected} rejected, ${f.claims.unverified} unverified`,
  );
  for (const c of f.claims.corrections)
    out.push(`- "${trim(c.claim, 40)}" → observed ${JSON.stringify(c.observed)}`);
  if (f.waiver_void.length)
    out.push(`Waivers voided by a changed identity: ${f.waiver_void.length}`);
  for (const v of f.waiver_void) out.push(`- ${v.cause}`);
  out.push(
    `Not examined: ${f.not_examined.length ? f.not_examined.map((n) => n.store).join(', ') : 'none listed'}`,
  );
  out.push('', '## Who did what');
  for (const w of f.who.filter((x) => x.task)) {
    out.push(`${w.task} ${w.step}: ${w.rung}/${i.rungModel(w.rung)}`);
  }
  out.push(`Fallbacks: ${f.fallbacks.length}`);
  for (const b of f.fallbacks) out.push(`- ${b.from} ${b.class}`);
  const byTask = Object.entries(f.repairs.byTask)
    .map(([t, n]) => `${t} ${n}`)
    .join(', ');
  out.push(`Repairs: ${f.repairs.total} total${byTask ? `, ${byTask}` : ''}`);
  out.push(
    '',
    '## Cost and time',
    `Elapsed: ${hhmm((last - first) / 1000)}   Worker time: ${hhmm(f.worker_wall_s)}`,
    `Tokens: ${f.usage.measured ? f.usage.tokens : 'unavailable'} (${f.usage.measured} of ${f.usage.total} measured)`,
    `Cost: ${f.usage.cost_measured ? `${f.usage.cost_measured < f.usage.total ? 'at least ' : ''}$${f.usage.cost_usd.toFixed(2)}` : 'unavailable'} (${f.usage.cost_measured ? `vendor CLI, ${f.usage.cost_measured} of ${f.usage.total} measured` : 'no source'})`,
    `Human interventions: ${f.interventions}`,
    '',
    ...shadowSection(i, f),
  );
  if (needsDecision && s.open_escalation) {
    const rec = s.escalations[s.open_escalation];
    out.push(
      '',
      '## Decision needed (escalations only)',
      `Decision: ${rec.reason}`,
      `Why automation cannot decide: ${trim(rec.summary, 60)}`,
      'Options:',
    );
    for (const o of rec.options) out.push(`- ${o.id}: ${trim(o.consequence, 60)}`);
    out.push(`Resume: ecp resume ${i.runId} --with-decision <file>`);
  }
  return `${out.join('\n')}\n`;
}

export function renderStatus(i: {
  runId: string;
  state: RunR;
  events: LedgerEvent[];
  now: number;
  rungModel?: (r: string) => string;
}): { text: string; json: Record<string, unknown> } {
  const s = i.state;
  const f = computeFigures(i.events);
  const first = i.events[0]?.at ? Date.parse(i.events[0].at) : i.now;
  const lastEv = i.events.at(-1);
  const ago = lastEv ? Math.max(0, Math.floor((i.now - Date.parse(lastEv.at)) / 1000)) : 0;
  const clock = (sec: number) =>
    `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const tasks = Object.values(s.tasks).map((t) => ({
    id: t.task_id,
    state: t.state,
    attempt: t.attempts,
    repair: t.repairs,
    rung: t.rung,
  }));
  const blockers =
    s.state.startsWith('PAUSED_') || s.state === 'ESCALATION_REQUIRED' ? [s.reason ?? s.state] : [];
  const result = ['READY_FOR_HUMAN_MERGE', 'PR_OPENED', 'MOCK_RUN_COMPLETE'].includes(s.state)
    ? `ecp/${i.runId}/integration`
    : 'none';
  const lines = [
    `RUN ${i.runId}`,
    `STATE ${s.state}`,
    `RISK ${s.risk}  DEPTH ${s.depth}`,
    `ELAPSED ${clock(Math.floor((i.now - first) / 1000))}  LAST_EVENT ${clock(ago)} ago ${lastEv?.type ?? 'none'}`,
    ...tasks.map((t) =>
      t.attempt
        ? `TASK ${t.id} ${t.state} attempt=${t.attempt} repair=${t.repair} rung=${t.rung}`
        : `TASK ${t.id} ${t.state}`,
    ),
    `BLOCKERS ${blockers.length ? blockers.join('; ') : 'none'}`,
    `SHADOW agreement=${f.shadow.matched}/${f.shadow.recorded} unavailable=${f.shadow.unavailable} skipped=${f.shadow.skipped}`,
    `USAGE tokens=${f.usage.measured ? f.usage.tokens : 'unavailable'} cost=${f.usage.cost_measured ? f.usage.cost_usd.toFixed(2) : 'unavailable'} cost_measured=${f.usage.cost_measured}/${f.usage.total} measured=${f.usage.measured}/${f.usage.total} invocations=${f.invocations}`,
    `RESULT ${result}`,
    `REPORT runs/${i.runId}/RUN_REPORT.md`,
  ];
  return {
    text: `${lines.join('\n')}\n`,
    json: {
      run: i.runId,
      state: s.state,
      risk: s.risk,
      depth: s.depth,
      tasks,
      blockers,
      shadow: {
        agreement: `${f.shadow.matched}/${f.shadow.recorded}`,
        unavailable: f.shadow.unavailable,
        skipped: f.shadow.skipped,
      },
      usage: {
        tokens: f.usage.measured ? f.usage.tokens : 'unavailable',
        cost: f.usage.cost_measured ? f.usage.cost_usd : 'unavailable',
        // Cost is measured apart from tokens, and may cover fewer invocations.
        cost_is_partial: f.usage.cost_measured > 0 && f.usage.cost_measured < f.usage.total,
        cost_measured: `${f.usage.cost_measured}/${f.usage.total}`,
        measured: `${f.usage.measured}/${f.usage.total}`,
        invocations: f.invocations,
      },
      result,
      report: `runs/${i.runId}/RUN_REPORT.md`,
    },
  };
}

export function renderMetrics(
  runs: { runId: string; state: RunR; events: LedgerEvent[] }[],
): string {
  const lines = [`Runs: ${runs.length}`];
  let tasks = 0;
  let unaided = 0;
  let interventions = 0;
  let repairs = 0;
  let measured = 0;
  let total = 0;
  let recorded = 0;
  let matched = 0;
  let unavailable = 0;
  let skipped = 0;
  let points = 0;
  let illegal = 0;
  let wall = 0;
  const escalations: Record<string, number> = {};
  for (const r of runs) {
    const f = computeFigures(r.events);
    interventions += f.interventions;
    repairs += f.repairs.total;
    measured += f.usage.measured;
    total += f.usage.total;
    wall += f.worker_wall_s;
    recorded += f.shadow.recorded;
    matched += f.shadow.matched;
    unavailable += f.shadow.unavailable;
    skipped += f.shadow.skipped;
    points += f.shadow.decision_points;
    illegal += f.shadow.illegal;
    for (const t of Object.values(r.state.tasks)) {
      tasks += 1;
      // An owner decision on the task, at any point, means it didn't finish without them.
      const decided = r.events.some(
        (e) => e.type === 'operator.decision' && e.task_id === t.task_id,
      );
      const escalated = Object.values<any>(r.state.escalations).some(
        (x) => x.task_id === t.task_id,
      );
      if (t.state === 'TASK_PASSED' && !decided && !escalated) unaided += 1;
    }
    for (const e of Object.values<any>(r.state.escalations))
      escalations[e.reason] = (escalations[e.reason] ?? 0) + 1;
  }
  lines.push(`Human interventions: ${interventions}`);
  lines.push(`Tasks finished without the owner: ${unaided}/${tasks}`);
  lines.push(`Repairs: ${repairs}`);
  lines.push(`Worker time: ${hhmm(wall)}`);
  lines.push(`Usage measured: ${measured} of ${total} invocations`);
  lines.push(`Shadow coverage: ${recorded} recorded of ${points} decision points`);
  lines.push(`Shadow unavailable ${unavailable}, skipped ${skipped}`);
  lines.push(`Shadow agreement: ${matched}/${recorded} (no target; v0.1 is measuring)`);
  lines.push(`Shadow rule-breaking proposals: ${illegal}`);
  const reasons = Object.entries(escalations)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  lines.push(`Escalations: ${reasons || 'none'}`);
  return `${lines.join('\n')}\n`;
}
