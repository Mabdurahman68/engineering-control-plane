import type { Plan, Spec } from '../contracts/index.ts';
import { globMatch } from '../gates/glob.ts';

function pathsOverlap(a: string[], b: string[]): boolean {
  const stem = (g: string) => g.replace(/\*.*$/, '').replace(/\/$/, '');
  for (const x of a) {
    for (const y of b) {
      const sx = stem(x);
      const sy = stem(y);
      if (sx === '' || sy === '') return true;
      if (sx === sy || sx.startsWith(`${sy}/`) || sy.startsWith(`${sx}/`)) return true;
      if (globMatch(x, sy) || globMatch(y, sx)) return true;
    }
  }
  return false;
}

function reaches(plan: Plan, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const t = plan.tasks.find((x) => x.task_id === from);
  return (t?.depends_on ?? []).some((d) => reaches(plan, d, to, seen));
}

// Contracts §2. Returns what's wrong; empty means valid.
export function planErrors(plan: Plan, spec: Spec, maxTasks: number, quick: boolean): string[] {
  const e: string[] = [];
  const n = plan.tasks.length;
  const min = quick ? 1 : 2;
  const max = Math.min(4, maxTasks);
  if (n < min || n > max) e.push(`plan has ${n} tasks; allowed ${min} to ${max}`);
  const ids = new Set(plan.tasks.map((t) => t.task_id));
  if (ids.size !== n) e.push('duplicate task IDs');
  for (const t of plan.tasks) {
    for (const d of t.depends_on) if (!ids.has(d)) e.push(`${t.task_id} depends on unknown ${d}`);
    for (const ac of t.acceptance_criteria) {
      if (!spec.acceptance_criteria.some((c) => c.id === ac))
        e.push(`${t.task_id} names unknown ${ac}`);
    }
    for (const rt of t.required_tests) {
      if (!spec.required_tests.some((x) => x.id === rt))
        e.push(`${t.task_id} names unknown test ${rt}`);
    }
  }
  const visit = new Map<string, number>();
  const cyclic = (id: string): boolean => {
    const st = visit.get(id) ?? 0;
    if (st === 1) return true;
    if (st === 2) return false;
    visit.set(id, 1);
    const t = plan.tasks.find((x) => x.task_id === id);
    const out = (t?.depends_on ?? []).some(cyclic);
    visit.set(id, 2);
    return out;
  };
  if (plan.tasks.some((t) => cyclic(t.task_id))) e.push('dependency cycle');
  else {
    for (const a of plan.tasks) {
      for (const b of plan.tasks) {
        if (a.task_id >= b.task_id) continue;
        if (!pathsOverlap(a.allowed_paths, b.allowed_paths)) continue;
        if (!reaches(plan, a.task_id, b.task_id) && !reaches(plan, b.task_id, a.task_id)) {
          e.push(`${a.task_id} and ${b.task_id} overlap, and aren't ordered`);
        }
      }
    }
  }
  for (const c of spec.acceptance_criteria) {
    if (c.human_reserved) continue;
    if (!plan.tasks.some((t) => t.acceptance_criteria.includes(c.id)))
      e.push(`${c.id} isn't covered`);
  }
  return e;
}

export function topoOrder(tasks: { task_id: string; depends_on: string[] }[]): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    done.add(id);
    const t = tasks.find((x) => x.task_id === id);
    for (const d of t?.depends_on ?? []) visit(d);
    out.push(id);
  };
  for (const t of tasks) visit(t.task_id);
  return out;
}
