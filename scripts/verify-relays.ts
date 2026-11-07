// Vendored relays match their pins, and the fake-CLI pins match the fixtures.
import { readFileSync } from 'node:fs';
import { fileSha, verifyRelayPins } from '../src/workers/relay/pins.ts';

const relays = verifyRelayPins(process.cwd());
const bad = [...relays.bad];
const pins = JSON.parse(readFileSync('src/workers/relay/fake-cli-pins.json', 'utf8'));
for (const [name, sha] of Object.entries<string>(pins)) {
  if (fileSha(`test/fake-cli/bin/${name}`) !== sha) bad.push(`fixture ${name}`);
}
if (bad.length) {
  console.error(`mismatch: ${bad.join(', ')}`);
  process.exit(1);
}
console.log('relays and fixtures match their pins');
