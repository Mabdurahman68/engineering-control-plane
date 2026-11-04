import type { ChangedFile, GitPort } from '../worktree/port.ts';
import { matchesAny } from './glob.ts';
import { scanText } from './secret.ts';

export const CONTROL_DEFAULTS = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.claude/**',
  '.codex/**',
  '.opencode/**',
  '.cursor/**',
  '.delegate/**',
  '.mcp.json',
  '.git/**',
  '.githooks/**',
  '.gitattributes',
];

export type CheckResult = { ok: boolean; detail: string; elements?: string[] };
const ok = (detail = 'ok'): CheckResult => ({ ok: true, detail });
const bad = (detail: string, elements?: string[]): CheckResult => ({ ok: false, detail, elements });

export function checkScope(
  changed: ChangedFile[],
  allowed: string[],
  forbidden: string[],
): CheckResult {
  const out = changed
    .map((f) => f.path)
    .filter((p) => !matchesAny(allowed, p) || matchesAny(forbidden, p));
  return out.length ? bad(`out of scope: ${out.join(', ')}`, out) : ok();
}

export function checkControl(changed: ChangedFile[], allowedControl: string[]): CheckResult {
  const out = changed
    .map((f) => f.path)
    .filter((p) => matchesAny(CONTROL_DEFAULTS, p) && !matchesAny(allowedControl, p));
  return out.length ? bad(`control files changed: ${out.join(', ')}`, out) : ok();
}

export function checkSecret(
  texts: { name: string; text: string }[],
  patterns: { id: string; re: RegExp }[],
): CheckResult {
  const hits = texts.flatMap((t) =>
    scanText(t.text, patterns).map((h) => `${t.name}:${h.line} (${h.pattern})`),
  );
  return hits.length ? bad(`secret-shaped text: ${hits.join(', ')}`, hits) : ok();
}

const MARKER = /^(<{7}( |$)|={7}$|>{7}( |$)|\|{7}( |$))/m;
export function checkNoMarkers(files: { path: string; content: string | null }[]): CheckResult {
  const out = files.filter((f) => f.content !== null && MARKER.test(f.content)).map((f) => f.path);
  return out.length ? bad(`conflict markers: ${out.join(', ')}`, out) : ok();
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/;
const SKIP_MARK = /\b(it|test|describe)\.(skip|todo)\b|\bx(it|describe|test)\(|\bskip\(/;
const ASSERT = /\b(expect|assert)\b/g;

export function isTestFile(p: string): boolean {
  return TEST_FILE.test(p);
}

// Existing test deleted, skipped or loosened; one signature per test file and change kind.
export async function checkTestChange(
  git: GitPort,
  base: string,
  commit: string,
  changed: ChangedFile[],
): Promise<CheckResult> {
  const elems: string[] = [];
  for (const f of changed) {
    if (!isTestFile(f.path)) continue;
    if (f.status === 'A') continue;
    if (f.status === 'D') {
      elems.push(`${f.path}|deleted`);
      continue;
    }
    const before = (await git.readFile(base, f.path)) ?? '';
    const after = (await git.readFile(commit, f.path)) ?? '';
    if (SKIP_MARK.test(after) && !SKIP_MARK.test(before)) elems.push(`${f.path}|skipped`);
    const count = (s: string) => (s.match(ASSERT) ?? []).length;
    if (count(after) < count(before)) elems.push(`${f.path}|loosened`);
  }
  return elems.length ? bad(`tests weakened: ${elems.join(', ')}`, elems) : ok();
}

function depsOf(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const p = JSON.parse(text);
    return {
      ...p.dependencies,
      ...p.devDependencies,
      ...p.optionalDependencies,
      ...p.peerDependencies,
    };
  } catch {
    return {};
  }
}

export async function checkNewDeps(
  git: GitPort,
  base: string,
  commit: string,
  changed: ChangedFile[],
): Promise<CheckResult> {
  const elems: string[] = [];
  for (const f of changed) {
    if (!/(^|\/)package\.json$/.test(f.path)) continue;
    const before = depsOf(await git.readFile(base, f.path));
    const after = depsOf(await git.readFile(commit, f.path));
    for (const [n, v] of Object.entries(after)) if (before[n] !== v) elems.push(`${n}@${v}`);
  }
  return elems.length ? bad(`new dependencies: ${elems.join(', ')}`, elems) : ok();
}

export function checkRepo(
  actualRoot: string,
  expectedRoot: string,
  baseExists: boolean,
): CheckResult {
  if (actualRoot !== expectedRoot)
    return bad(`repo identity ${actualRoot}, wanted ${expectedRoot}`);
  return baseExists ? ok() : bad('base commit is absent');
}
export function checkClean(clean: boolean): CheckResult {
  return clean ? ok() : bad('tree is dirty');
}
export function checkNoPush(remotes: string[]): CheckResult {
  return remotes.length === 0 ? ok() : bad(`target has push paths: ${remotes.join(', ')}`, remotes);
}
export function checkTreeId(expected: string, actual: string): CheckResult {
  return expected === actual ? ok() : bad(`tree ${actual}, wanted ${expected}`);
}
export function checkSpecLock(lockedSha: string, currentSha: string): CheckResult {
  return lockedSha === currentSha ? ok() : bad('spec.lock changed');
}
export function checkGitCfg(baseline: string, current: string): CheckResult {
  return baseline === current ? ok() : bad('.git/config or hooks changed');
}
export function checkNoCommit(expectedHead: string, head: string): CheckResult {
  return expectedHead === head ? ok() : bad(`HEAD moved to ${head}`);
}

export type ReviewFacts = { slot: number; valid: boolean; independent: boolean; verdict: string };
export function checkReview(reviews: ReviewFacts[], requiredSlots: number): CheckResult {
  for (let slot = 0; slot < requiredSlots; slot++) {
    const r = reviews.find((x) => x.slot === slot);
    if (!r) return bad(`review slot ${slot} is empty`);
    if (!r.valid) return bad(`review slot ${slot} is invalid`);
    if (!r.independent) return bad(`review slot ${slot} isn't independent`);
  }
  return ok();
}
export function checkReviewReadOnly(before: string, after: string): CheckResult {
  return before === after ? ok() : bad('the review checkout changed');
}

export type EvidenceRecord = {
  gate: string;
  log_sha: string | null;
  tree_hash: string | null;
  log_path?: string | null;
};
export function checkEvidence(
  records: EvidenceRecord[],
  candidateTree: string,
  verifyArtifact: (r: EvidenceRecord) => boolean,
): CheckResult {
  const out: string[] = [];
  for (const r of records) {
    if (!r.log_sha || !r.tree_hash) out.push(`${r.gate}: missing hash`);
    else if (r.tree_hash !== candidateTree) out.push(`${r.gate}: stale`);
    else if (!verifyArtifact(r)) out.push(`${r.gate}: artifact mismatch`);
  }
  return out.length ? bad(out.join(', '), out) : ok();
}

export type AcFacts = { id: string; human_reserved: boolean; evidenced: boolean };
export function checkAc(criteria: AcFacts[], humanVerified: string[]): CheckResult {
  const out = criteria
    .filter((c) => !c.evidenced && !c.human_reserved && !humanVerified.includes(c.id))
    .map((c) => c.id);
  return out.length ? bad(`no evidence for ${out.join(', ')}`, out) : ok();
}

export function checkLedger(load: () => unknown): CheckResult {
  try {
    load();
    return ok();
  } catch (err) {
    return bad(`ledger: ${(err as Error).message}`);
  }
}

export function checkCap(used: number, cap: number): CheckResult {
  return used < cap ? ok() : bad(`${used} of ${cap} used`);
}
