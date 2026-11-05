import type { Publisher } from '../core/ports.ts';
import type { PolicyBundle } from '../contracts/index.ts';

export function makePublisher(_o: {
  home: string;
  repoRoot: string;
  policy: PolicyBundle;
}): Publisher | null {
  return null;
}
