import type { PolicyBundle, WorkerAdapter } from '../../contracts/index.ts';

// M9 fills this in. Until then there's no route to a real CLI.
export function makeRelayAdapters(_o: {
  policy: PolicyBundle;
  repoRoot: string;
  home: string;
}): Record<string, WorkerAdapter> {
  return {};
}
