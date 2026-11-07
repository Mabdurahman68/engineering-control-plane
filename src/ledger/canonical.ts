import { createHash } from 'node:crypto';

// Canonical JSON: sorted keys, no whitespace. Undefined is dropped, as JSON does.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
