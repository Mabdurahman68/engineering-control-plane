// The proof tool. This build runs it on fake actors only, so it tests the tool: the boundaries
// themselves can only be proven on the dedicated machine (M11), and this proof can't authorise that.
export type Role = 'gate' | 'worker';
export type Op = 'read' | 'write';
export type Surface =
  | 'ledger'
  | 'hidden_checks'
  | 'gh_login'
  | 'subscription_stores'
  | 'worktree'
  | 'gate_checkout'
  | 'git_common';

type Closed = { surface: Surface; ops: Op[] };
const BOTH: Op[] = ['read', 'write'];

// What each user may not do, from the architecture's table: `none` closes both, `no write` one.
export const SURFACES_FOR: Record<Role, Closed[]> = {
  worker: [
    { surface: 'ledger', ops: BOTH },
    { surface: 'hidden_checks', ops: BOTH },
    { surface: 'gh_login', ops: BOTH },
    { surface: 'gate_checkout', ops: BOTH },
    { surface: 'git_common', ops: ['write'] },
  ],
  gate: [
    { surface: 'ledger', ops: BOTH },
    { surface: 'hidden_checks', ops: BOTH },
    { surface: 'gh_login', ops: BOTH },
    { surface: 'subscription_stores', ops: BOTH },
    { surface: 'worktree', ops: BOTH },
    { surface: 'git_common', ops: ['write'] },
  ],
};

export const REQUIRED_ACTORS: { id: string; role: Role }[] = [
  { id: 'gate', role: 'gate' },
  ...['codex', 'claude', 'opencode'].flatMap((cli) => [
    { id: `${cli}-write`, role: 'worker' as const },
    { id: `${cli}-read-only`, role: 'worker' as const },
  ]),
];

export type EscapeResult = {
  heartbeat_stopped: boolean;
  process_count: number;
  revoked_write_denied: boolean;
};

export type Actor = {
  id: string;
  role: Role;
  // Which attempts this actor actually made. Anything not made is a gap in the proof.
  attempted(surface: Surface, op: Op): boolean;
  attempt(surface: Surface, op: Op): 'denied' | 'allowed' | 'error';
  escapingChild(): EscapeResult | null;
};

export type IsolationProof = {
  schema: 'isolation_proof.v1';
  provenance: 'fake_actors';
  machine: string;
  passed: boolean;
  attempts: { actor: string; surface: Surface; op: Op; result: string }[];
  escapes: { actor: string; result: EscapeResult | null }[];
  incomplete: string[];
  failures: string[];
};

// Any failure or gap fails it. Only an attempt that was made and denied counts as evidence.
export function runIsolationProof(o: { actors: Actor[]; machine: string }): IsolationProof {
  const attempts: IsolationProof['attempts'] = [];
  const escapes: IsolationProof['escapes'] = [];
  const incomplete: string[] = [];
  const failures: string[] = [];
  for (const need of REQUIRED_ACTORS) {
    const actor = o.actors.find((a) => a.id === need.id);
    if (!actor) {
      incomplete.push(`actor ${need.id}`);
      continue;
    }
    for (const { surface, ops } of SURFACES_FOR[need.role]) {
      for (const op of ops) {
        if (!actor.attempted(surface, op)) {
          incomplete.push(`${need.id}: ${surface} ${op}`);
          continue;
        }
        const result = actor.attempt(surface, op);
        attempts.push({ actor: need.id, surface, op, result });
        if (result !== 'denied') failures.push(`${need.id} ${op} ${surface}: ${result}`);
      }
    }
    if (need.role === 'worker') {
      const result = actor.escapingChild();
      escapes.push({ actor: need.id, result });
      if (!result) incomplete.push(`${need.id}: escaping child`);
      else if (
        !result.heartbeat_stopped ||
        result.process_count !== 0 ||
        !result.revoked_write_denied
      ) {
        failures.push(`${need.id}: an escaping child survived kill-all`);
      }
    }
  }
  return {
    schema: 'isolation_proof.v1',
    provenance: 'fake_actors',
    machine: o.machine,
    passed: failures.length === 0 && incomplete.length === 0,
    attempts,
    escapes,
    incomplete,
    failures,
  };
}

export function fakeActors(
  o: {
    leak?: { actor: string; op: Op };
    skip?: { actor: string; surface: Surface };
    error?: { actor: string };
    escape?: Partial<EscapeResult>;
  } = {},
): Actor[] {
  return REQUIRED_ACTORS.map(({ id, role }) => ({
    id,
    role,
    attempted: (surface) => !(o.skip?.actor === id && o.skip.surface === surface),
    attempt: (_surface, op) => {
      if (o.error?.actor === id) return 'error';
      return o.leak?.actor === id && o.leak.op === op ? 'allowed' : 'denied';
    },
    escapingChild: () =>
      role === 'worker'
        ? { heartbeat_stopped: true, process_count: 0, revoked_write_denied: true, ...o.escape }
        : null,
  }));
}
