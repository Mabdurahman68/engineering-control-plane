import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { PublishForbidden } from '../contracts/index.ts';
import { publishForbiddenSchema } from '../contracts/index.ts';

export type DenyList = { patterns: RegExp[]; allow: string[] };

// Held outside the repository. A missing or empty list fails the gate.
export function loadDenyList(path: string): DenyList | null {
  if (!existsSync(path)) return null;
  const allow: string[] = [];
  const patterns: RegExp[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('#allow ')) allow.push(line.slice(7));
    else if (!line.startsWith('#')) patterns.push(new RegExp(line));
  }
  return patterns.length ? { patterns, allow } : null;
}

export function loadForbidden(path: string): PublishForbidden | null {
  if (!existsSync(path)) return null;
  const parsed = publishForbiddenSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) return null;
  const f = parsed.data;
  return f.names.length || f.dirs.length || f.hashes.length || f.markers.length ? f : null;
}

export function scanForNames(text: string, deny: DenyList): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    for (const a of deny.allow) line = line.split(a).join('');
    for (const p of deny.patterns) if (p.test(line)) hits.push(`line ${i + 1} (${p.source})`);
  });
  return hits;
}
