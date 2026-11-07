import type { ZodType } from 'zod';

// The final message must end in one fenced JSON block (contracts §3).
export function extractBlock(message: string): unknown | undefined {
  const text = message.trimEnd();
  const m = /```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

export function parseBlock<T>(
  message: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  const raw = extractBlock(message);
  if (raw === undefined) return { ok: false, error: 'no fenced JSON block at the end' };
  const res = schema.safeParse(raw);
  if (!res.success) return { ok: false, error: res.error.message.slice(0, 800) };
  return { ok: true, value: res.data };
}
