import type { LedgerEvent, PredictedDefect } from '../contracts/index.ts';
import { normaliseText, stallKey } from '../review/fingerprint.ts';

export type PredictionResult = {
  index: number;
  predicted_stall_key: string | null;
  status: 'exact_match' | 'near_match' | 'not_observed' | 'horizon_not_reached';
  matched: { fingerprint: string | null; signature: string | null; evidence_seq: number | null };
};

const none = { fingerprint: null, signature: null, evidence_seq: null };

// Where a horizon ends, in the events after the decision. Null means it never ended here.
export function horizonEnd(
  horizon: PredictedDefect['horizon'],
  after: LedgerEvent[],
  taskId: string | null,
): { reached: boolean; seq: number | null } {
  const sameTask = (e: LedgerEvent) => taskId === null || e.task_id === taskId;
  switch (horizon) {
    case 'next_gate': {
      const hit = after.find((e) => e.type === 'gate.finished' && !e.data.baseline && sameTask(e));
      return hit ? { reached: true, seq: hit.seq } : { reached: false, seq: null };
    }
    case 'next_review': {
      const hit = after.find((e) => e.type === 'review.collected' && sameTask(e));
      return hit ? { reached: true, seq: hit.seq } : { reached: false, seq: null };
    }
    case 'task_end': {
      const hit = after.find(
        (e) =>
          e.type === 'task.state_changed' &&
          sameTask(e) &&
          ['TASK_PASSED', 'TASK_ESCALATED', 'TASK_CANCELLED'].includes(String(e.data.to)),
      );
      return hit ? { reached: true, seq: hit.seq } : { reached: false, seq: null };
    }
    case 'integration': {
      const hit = after.find((e) => e.type === 'run.state_changed' && e.data.to === 'VERIFYING');
      return hit ? { reached: true, seq: hit.seq } : { reached: false, seq: null };
    }
    case 'run_end': {
      const hit = after.find(
        (e) =>
          e.type === 'run.state_changed' &&
          [
            'READY_FOR_HUMAN_MERGE',
            'MOCK_RUN_COMPLETE',
            'FAILED',
            'CANCELLED',
            'PR_OPENED',
          ].includes(String(e.data.to)),
      );
      return hit ? { reached: true, seq: hit.seq } : { reached: false, seq: null };
    }
    default:
      // post_merge needs an owner record, which a run can't have.
      return { reached: false, seq: null };
  }
}

// Matches a prediction against what happened, from the prediction's own fields only. No identifier
// from outside it. A novel defect, absent from the frozen bundle, can still match.
export function matchPrediction(
  p: PredictedDefect,
  index: number,
  after: LedgerEvent[],
  taskId: string | null,
): PredictionResult {
  const horizon = horizonEnd(p.horizon, after, taskId);
  const within = after.filter((e) => horizon.seq === null || e.seq <= horizon.seq);
  const sameTask = (e: LedgerEvent) =>
    taskId === null || e.task_id === taskId || e.task_id === null;
  if (p.kind === 'finding') {
    const key = stallKey({
      criterion: p.criterion,
      file: p.file,
      category: p.category,
      finding_type: p.finding_type,
      subject: p.subject,
    });
    let near: PredictionResult | null = null;
    for (const e of within) {
      if (e.type !== 'review.collected' || !sameTask(e)) continue;
      for (const f of (e.data.findings ?? []) as any[]) {
        if (f.stall_key === key) {
          return {
            index,
            predicted_stall_key: key,
            status: 'exact_match',
            matched: { fingerprint: f.fingerprint, signature: null, evidence_seq: e.seq },
          };
        }
        const close =
          f.criterion === p.criterion &&
          f.file === p.file &&
          f.category === p.category &&
          f.finding_type === p.finding_type;
        if (close && !near) {
          near = {
            index,
            predicted_stall_key: key,
            status: 'near_match',
            matched: { fingerprint: f.fingerprint, signature: null, evidence_seq: e.seq },
          };
        }
      }
    }
    if (near) return near;
    return {
      index,
      predicted_stall_key: key,
      status: horizon.reached ? 'not_observed' : 'horizon_not_reached',
      matched: none,
    };
  }
  // A gate failure. With no test name and no text, same gate is only near: there's nothing to tell it apart.
  const discriminators = [p.failing_test, p.error_contains].filter((x): x is string => Boolean(x));
  let near: PredictionResult | null = null;
  for (const e of within) {
    if (e.type !== 'gate.finished' || !sameTask(e)) continue;
    for (const r of (e.data.results ?? []) as any[]) {
      if (r.id !== p.gate_id || r.status !== 'FAIL') continue;
      const lines = normaliseText(((r.normalised as string[]) ?? []).join('\n'));
      const allPresent =
        discriminators.length > 0 && discriminators.every((d) => lines.includes(normaliseText(d)));
      if (allPresent) {
        return {
          index,
          predicted_stall_key: null,
          status: 'exact_match',
          matched: { fingerprint: null, signature: r.signature ?? null, evidence_seq: e.seq },
        };
      }
      if (!near)
        near = {
          index,
          predicted_stall_key: null,
          status: 'near_match',
          matched: { fingerprint: null, signature: r.signature ?? null, evidence_seq: e.seq },
        };
    }
  }
  if (near) return near;
  return {
    index,
    predicted_stall_key: null,
    status: horizon.reached ? 'not_observed' : 'horizon_not_reached',
    matched: none,
  };
}
