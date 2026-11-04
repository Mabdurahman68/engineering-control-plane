import type { PolicyBundle } from '../contracts/index.ts';
import type { RunR, TaskRec } from './reducer.ts';

export function familyOfModel(policy: PolicyBundle, model: string): string {
  return policy.families.models[model] ?? 'unknown';
}
export function familyOfRung(policy: PolicyBundle, rung: string): string {
  const r = policy.workers.rungs[rung];
  return r ? familyOfModel(policy, r.model) : 'unknown';
}

// Families of every rung with a retained snapshot in the tree's lineage, dependencies included.
export function authorsOfTask(s: RunR, taskId: string, seen = new Set<string>()): string[] {
  const t = s.tasks[taskId];
  if (!t || seen.has(taskId)) return [];
  seen.add(taskId);
  const out = new Set<string>(t.retained_families);
  for (const dep of t.spec.depends_on) for (const f of authorsOfTask(s, dep, seen)) out.add(f);
  // A conflict resolution contains both parents' work, and the incoming one isn't merged yet.
  if (t.conflict_of) for (const f of authorsOfTask(s, t.conflict_of, seen)) out.add(f);
  if (t.is_integration) for (const f of s.authors_integrated) out.add(f);
  return [...out];
}

export function authorsIntegrated(s: RunR): string[] {
  const out = new Set<string>(s.authors_integrated);
  for (const id of s.integration.merged) {
    for (const f of authorsOfTask(s, id)) out.add(f);
  }
  return [...out];
}

// reserved(run) = families with a retained snapshot ∪ families of every open attempt (§4.7).
export function reservedFamilies(s: RunR): Set<string> {
  const out = new Set<string>(s.authors_integrated);
  for (const t of Object.values(s.tasks)) for (const f of t.retained_families) out.add(f);
  for (const a of Object.values(s.attempts)) {
    if (a.mode === 'write' && !a.released && !a.retained) out.add(a.family);
  }
  return out;
}

export function reviewFamilies(policy: PolicyBundle): string[] {
  const out = new Set<string>();
  for (const r of policy.workers.ladders.review) {
    const f = familyOfRung(policy, r);
    if (f !== 'unknown') out.add(f);
  }
  return [...out];
}

// Would taking this rung leave no configured family to review the integrated candidate?
export function rungWouldStrandReview(s: RunR, policy: PolicyBundle, rung: string): boolean {
  const reserved = reservedFamilies(s);
  reserved.add(familyOfRung(policy, rung));
  return !reviewFamilies(policy).some((f) => !reserved.has(f));
}

export function openWriters(s: RunR): number {
  return Object.values(s.attempts).filter(
    (a) => a.mode === 'write' && !a.finished && !a.fenced && a.step !== 'plan',
  ).length;
}

export function currentAttempt(s: RunR, taskId: string | null, steps?: string[]) {
  let found: RunR['attempts'][string] | null = null;
  for (const a of Object.values(s.attempts)) {
    if (a.task_id !== taskId) continue;
    if (a.fenced || a.class !== null) continue;
    if (steps && !steps.includes(a.step)) continue;
    found = a;
  }
  return found;
}

export function lastSnapshot(t: TaskRec) {
  return t.snapshots.length ? t.snapshots[t.snapshots.length - 1] : null;
}

export function resetPoint(t: TaskRec): string {
  const snap = lastSnapshot(t);
  return snap ? snap.commit : (t.base_commit as string);
}
