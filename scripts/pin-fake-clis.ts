// Records the fixtures' hashes. Only for a deliberate fixture change: the diff shows up in review.
import { writeFileSync } from 'node:fs';
import { fileSha } from '../src/workers/relay/pins.ts';

const names = ['codex', 'claude', 'opencode', 'fake-cli-core.mjs'];
const pins = Object.fromEntries(names.map((n) => [n, fileSha(`test/fake-cli/bin/${n}`)]));
writeFileSync('src/workers/relay/fake-cli-pins.json', `${JSON.stringify(pins, null, 2)}\n`);
