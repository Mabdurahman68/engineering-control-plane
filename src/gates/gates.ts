import { sha256 } from '../ledger/canonical.ts';
import type { CommandSpec, Spec } from '../contracts/index.ts';
import type { ChangedFile, CommandRunner, GitPort, RunStore } from '../worktree/port.ts';
import {
  type CheckResult,
  checkControl,
  checkGitCfg,
  checkNewDeps,
  checkNoCommit,
  checkNoMarkers,
  checkScope,
  checkSecret,
  checkTestChange,
  checkTreeId,
} from './checks.ts';
import { gateSignature, normaliseLines } from './signature.ts';

export const REPAIRABLE_HARD = [
  'H-SCOPE',
  'H-TESTS-RAN',
  'H-TESTS-PASS',
  'H-TYPECHECK',
  'H-BUILD',
  'H-NOMARKERS',
  'H-TREE-ID',
  'H-CLAIMS',
  'H-AC',
];
export const NON_REPAIRABLE_HARD = ['H-SECRET', 'H-CONTROL', 'H-GITCFG', 'H-NOCOMMIT'];

export type GateStatus = 'PASS' | 'FAIL' | 'WAIVED' | 'SKIPPED';
export type GateResult = {
  id: string;
  status: GateStatus;
  soft: boolean;
  signature: string | null;
  elements: string[];
  uncovered: string[];
  detail: string;
  command: string[] | null;
  exit: number | null;
  duration_ms: number | null;
  log_sha: string | null;
  log_path: string | null;
  tree_hash: string;
  normalised: string[];
};

export type GateWaiver = { gate_id: string | null; signature_element: string | null };

export type GateInput = {
  git: GitPort;
  runner: CommandRunner;
  store: RunStore;
  spec: Spec;
  subject: string;
  attemptN: number;
  allowed: string[];
  forbidden: string[];
  base: string;
  commit: string;
  tree: string;
  checkout: string;
  requiredTests: Spec['required_tests'];
  // Test IDs this subject must run. An ID with no command in the spec can't have been run.
  requiredTestIds: string[];
  runFull: boolean;
  fullRuns: number;
  baselineFullSignature: string | null;
  secretPatterns: { id: string; re: RegExp }[];
  waivers: GateWaiver[];
  worker?: {
    worktree: string;
    expectedHead: string;
    configBaseline: string;
    artifactTexts: { name: string; text: string }[];
  };
  // Runs last, once tests have produced evidence.
  claims?: (results: GateResult[], changed: ChangedFile[]) => Promise<CheckResult>;
};

export type GateOutcome = {
  results: GateResult[];
  changed: ChangedFile[];
  tree_changed: string[] | null;
  classification:
    | 'tree_changed'
    | 'hard_nonrepairable'
    | 'hard_repairable'
    | 'soft_failed'
    | 'passed';
};

function result(
  id: string,
  soft: boolean,
  tree: string,
  r: CheckResult,
  extra: Partial<GateResult> = {},
): GateResult {
  return {
    id,
    status: r.ok ? 'PASS' : 'FAIL',
    soft,
    signature: null,
    elements: r.elements ?? [],
    uncovered: r.ok ? [] : (r.elements ?? []),
    detail: r.detail,
    command: null,
    exit: null,
    duration_ms: null,
    log_sha: null,
    log_path: null,
    tree_hash: tree,
    normalised: [],
    ...extra,
  };
}

function writeEvidence(input: GateInput, gate: string, r: GateResult, log: string) {
  const rel = `evidence/${input.subject}/${gate}-${input.attemptN}`;
  input.store.write(`${rel}.log`, log);
  r.log_sha = sha256(log);
  r.log_path = `${rel}.log`;
  input.store.write(`${rel}.json`, JSON.stringify(r, null, 2));
}

async function runCommand(input: GateInput, gate: string, soft: boolean, spec: CommandSpec) {
  const res = await input.runner.run(spec.command, {
    cwd: input.checkout,
    timeout_s: spec.timeout_s,
  });
  const r = result(gate, soft, input.tree, {
    ok: res.code === 0,
    detail: res.timed_out ? `timed out after ${spec.timeout_s}s` : `exit ${res.code}`,
  });
  r.command = spec.command;
  r.exit = res.code;
  r.duration_ms = res.duration_ms;
  if (res.code !== 0) {
    r.signature = gateSignature(gate, res.log);
    r.elements = [r.signature];
    r.uncovered = [r.signature];
    r.normalised = normaliseLines(res.log);
  }
  writeEvidence(input, gate, r, res.log);
  return r;
}

// A soft-gate failure is WAIVED only if a waiver covers every one of its elements.
function applyWaivers(r: GateResult, waivers: GateWaiver[]) {
  if (r.status !== 'FAIL' || !r.soft) return;
  const covered = (e: string) =>
    waivers.some((w) => w.gate_id === r.id && w.signature_element === e);
  r.uncovered = r.elements.filter((e) => !covered(e));
  if (r.elements.length > 0 && r.uncovered.length === 0) r.status = 'WAIVED';
}

export function classify(
  results: GateResult[],
  treeChanged: string[] | null,
): GateOutcome['classification'] {
  if (treeChanged) return 'tree_changed';
  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.some((r) => !r.soft && NON_REPAIRABLE_HARD.includes(r.id)))
    return 'hard_nonrepairable';
  if (failed.some((r) => !r.soft)) return 'hard_repairable';
  if (failed.some((r) => r.soft)) return 'soft_failed';
  return 'passed';
}

export async function runGates(input: GateInput): Promise<GateOutcome> {
  const { git, spec, tree } = input;
  const out: GateResult[] = [];
  const changed = await git.changedFiles(input.base, input.commit);

  if (input.worker) {
    const w = input.worker;
    out.push(
      result('H-GITCFG', false, tree, checkGitCfg(w.configBaseline, await git.configFingerprint())),
    );
    out.push(
      result(
        'H-NOCOMMIT',
        false,
        tree,
        checkNoCommit(w.expectedHead, await git.worktreeHead(w.worktree)),
      ),
    );
  }
  out.push(result('H-SCOPE', false, tree, checkScope(changed, input.allowed, input.forbidden)));
  out.push(result('H-CONTROL', false, tree, checkControl(changed, spec.allowed_control_paths)));

  const changedContents = await Promise.all(
    changed
      .filter((f) => f.status !== 'D')
      .map(async (f) => ({ path: f.path, content: await git.readFile(input.commit, f.path) })),
  );
  const scanTexts = [
    { name: 'diff', text: await git.diffText(input.base, input.commit) },
    ...(input.worker?.artifactTexts ?? []),
  ];
  out.push(result('H-SECRET', false, tree, checkSecret(scanTexts, input.secretPatterns)));
  out.push(result('H-NOMARKERS', false, tree, checkNoMarkers(changedContents)));

  // Commands. These run worker-written code, in a disposable checkout.
  const ran: string[] = [];
  let testsPass = true;
  const testDetails: string[] = [];
  for (const t of input.requiredTests) {
    const r = await runCommand(input, `test-${t.id}`, false, {
      command: t.command,
      timeout_s: t.timeout_s,
    });
    ran.push(t.id);
    if (r.status !== 'PASS') {
      testsPass = false;
      testDetails.push(t.id);
    }
    out.push(r);
  }
  out.push(
    result('H-TESTS-RAN', false, tree, {
      ok: input.requiredTestIds.every((id) => ran.includes(id)),
      detail: `ran ${ran.length} of ${input.requiredTestIds.length}`,
    }),
  );
  out.push(
    result('H-TESTS-PASS', false, tree, {
      ok: testsPass,
      detail: testsPass ? 'all passed' : `failed: ${testDetails.join(', ')}`,
    }),
  );
  for (const [gate, key] of [
    ['H-TYPECHECK', 'typecheck'],
    ['H-BUILD', 'build'],
  ] as const) {
    const spec2 = spec.gate_commands[key];
    if (spec2) out.push(await runCommand(input, gate, false, spec2));
  }
  if (input.runFull) {
    for (let i = 0; i < input.fullRuns; i++) {
      const r = await runCommand(input, 'S-REGRESSION', true, spec.full_test_command);
      const baselineSame = r.status === 'FAIL' && r.signature === input.baselineFullSignature;
      if (baselineSame) {
        r.status = 'PASS';
        r.uncovered = [];
        r.detail = 'same failure as the baseline';
      }
      out.push(r);
      if (r.status === 'FAIL') break;
    }
  }
  const softs: GateResult[] = [];
  const testChange = await checkTestChange(git, input.base, input.commit, changed);
  softs.push(result('S-TESTCHANGE', true, tree, testChange));
  const deps = await checkNewDeps(git, input.base, input.commit, changed);
  softs.push(result('S-DEP', true, tree, deps));
  if (spec.gate_commands.lint)
    softs.push(await runCommand(input, 'S-LINT', true, spec.gate_commands.lint));
  out.push(...softs);
  for (const r of out) applyWaivers(r, input.waivers);

  // Tree identity: anything a gate command changed voids all evidence from this run.
  const after = await git.worktreeTree(input.checkout);
  const identity = checkTreeId(tree, after);
  out.push(result('H-TREE-ID', false, tree, identity));
  let treeChanged: string[] | null = null;
  if (!identity.ok) {
    treeChanged = [];
    const scratch = await git.commitTree(after, [input.commit], 'gate tree');
    treeChanged = (await git.changedFiles(input.commit, scratch)).map((f) => f.path);
  }

  // Claims go last, once evidence exists, and only on evidence that still counts.
  if (input.claims && !treeChanged) {
    out.push(result('H-CLAIMS', false, tree, await input.claims(out, changed)));
  }
  return {
    results: out,
    changed,
    tree_changed: treeChanged,
    classification: classify(out, treeChanged),
  };
}
