import type { ComputedFinding, ReviewFinding } from '../contracts/index.ts';
import { sha256 } from '../ledger/canonical.ts';

export function normaliseText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function stallKey(f: {
  criterion: string;
  file: string | null;
  category: string;
  finding_type: string;
  subject: string;
}): string {
  return [f.criterion, f.file ?? '', f.category, f.finding_type, normaliseText(f.subject)].join(
    '|',
  );
}

const PLACEHOLDERS = new Set([
  'n/a',
  'na',
  'none',
  'todo',
  'tbd',
  '-',
  '--',
  '...',
  'unknown',
  'placeholder',
  'see above',
  'x',
]);
export function isPlaceholder(s: string): boolean {
  return PLACEHOLDERS.has(normaliseText(s));
}

export type AnchorSource = {
  tree: string;
  readFile(path: string): Promise<string | null>;
  blobId(path: string): Promise<string>;
};

export async function anchorOf(f: { file: string | null; line: number | null }, src: AnchorSource) {
  if (f.file === null) return `tree:${src.tree}`;
  if (f.line === null) return `blob:${await src.blobId(f.file)}`;
  const text = await src.readFile(f.file);
  const lines = (text ?? '').split('\n');
  const from = Math.max(0, f.line - 1 - 3);
  const to = Math.min(lines.length, f.line + 3);
  const hunk = lines
    .slice(from, to)
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .join('\n');
  return `hunk:${sha256(hunk)}`;
}

export function defectDigest(f: { observed: string; expected: string }): string {
  return sha256(`${normaliseText(f.observed)}\n${normaliseText(f.expected)}`);
}

export async function computeFinding(
  f: ReviewFinding,
  src: AnchorSource,
): Promise<ComputedFinding> {
  const stall_key = stallKey(f);
  const anchor = await anchorOf(f, src);
  const defect_digest = defectDigest(f);
  return {
    ...f,
    stall_key,
    anchor,
    defect_digest,
    fingerprint: `${stall_key}|${anchor}|${defect_digest}`,
  };
}

// Identity problems that make a review invalid. Code never repairs them.
export async function identityErrors(
  findings: ReviewFinding[],
  src: AnchorSource,
): Promise<string[]> {
  const errors: string[] = [];
  const byKey = new Map<string, string>();
  for (const [i, f] of findings.entries()) {
    for (const k of ['subject', 'observed', 'expected'] as const) {
      if (isPlaceholder(f[k])) errors.push(`finding ${i}: placeholder ${k}`);
    }
    const key = stallKey(f);
    const digest = defectDigest(f);
    const seen = byKey.get(key);
    if (seen !== undefined && seen !== digest) {
      errors.push(`finding ${i}: same subject as an earlier finding, different defect`);
    }
    byKey.set(key, digest);
    if (f.line !== null) {
      if (f.file === null) errors.push(`finding ${i}: line with no file`);
      else {
        const text = await src.readFile(f.file);
        const count = text === null ? 0 : text.split('\n').length;
        if (f.line < 1 || f.line > count)
          errors.push(`finding ${i}: line ${f.line} is outside ${f.file}`);
      }
    }
  }
  return errors;
}
