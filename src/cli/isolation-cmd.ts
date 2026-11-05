import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fakeActors, runIsolationProof } from '../isolation/prove.ts';
import { machineId, proofPath } from '../workers/relay/real-worker-guard.ts';

// Fake actors only, in this build. It proves the tool works, and it can't authorise a real worker: the
// boundaries can only be proven on the dedicated machine.
export async function isolationCommand(_args: string[]) {
  const proof = runIsolationProof({ actors: fakeActors(), machine: machineId() });
  const path = proofPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`);
  process.stdout.write(
    `isolation proof ${proof.passed ? 'passed' : 'FAILED'}, on fake actors only: this authorises nothing\n${path}\n`,
  );
  process.exitCode = proof.passed ? 0 : 1;
}
