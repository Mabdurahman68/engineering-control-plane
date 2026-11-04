import type { SecretPatterns } from '../contracts/index.ts';

export type SecretHit = { pattern: string; line: number };

export function compileSecretPatterns(p: SecretPatterns): { id: string; re: RegExp }[] {
  return p.patterns.map((x) => ({ id: x.id, re: new RegExp(x.regex) }));
}

export function scanText(text: string, patterns: { id: string; re: RegExp }[]): SecretHit[] {
  const hits: SecretHit[] = [];
  text.split('\n').forEach((l, i) => {
    for (const p of patterns) if (p.re.test(l)) hits.push({ pattern: p.id, line: i + 1 });
  });
  return hits;
}
