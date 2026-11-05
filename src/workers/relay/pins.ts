import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Vendored relays match PIN.json. Relay files are never edited locally.
export function verifyRelayPins(root: string): { ok: boolean; bad: string[] } {
  const pinPath = join(root, 'vendor/delegate-skills/PIN.json');
  if (!existsSync(pinPath)) return { ok: false, bad: ['PIN.json is missing'] };
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const bad: string[] = [];
  for (const [rel, sha] of Object.entries<string>(pin.files)) {
    const p = join(root, 'vendor/delegate-skills', rel);
    if (!existsSync(p) || fileSha(p) !== sha) bad.push(rel);
  }
  if (!existsSync(join(root, 'vendor/delegate-skills/LICENSE'))) bad.push('LICENSE');
  return { ok: bad.length === 0, bad };
}
