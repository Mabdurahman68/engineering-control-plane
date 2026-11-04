// Confirms package.json uses the exact versions fixed by the build plan, and the toolchain matches.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PINS: Record<string, string> = {
  zod: '4.6.7',
  yaml: '2.9.1',
  typescript: '7.0.2',
  vitest: '5.1.0',
  '@types/node': '22.20.5',
  '@biomejs/biome': '2.6.5',
};
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const bad: string[] = [];
for (const [name, ver] of Object.entries(PINS)) {
  if (deps[name] !== ver) bad.push(`${name}: wanted ${ver}, have ${deps[name]}`);
}
for (const name of Object.keys(deps)) if (!(name in PINS)) bad.push(`${name}: not pinned by plan`);
for (const name of Object.keys(pkg.dependencies)) {
  if (!['zod', 'yaml'].includes(name)) bad.push(`${name}: runtime dependency beyond the plan`);
}
const installed = (name: string) =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
for (const [name, ver] of Object.entries(PINS)) {
  if (installed(name) !== ver) bad.push(`${name}: installed ${installed(name)}, wanted ${ver}`);
}
if (process.version !== 'v22.23.1') bad.push(`node ${process.version}, wanted v22.23.1`);
const pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
if (pnpm !== '11.1.1') bad.push(`pnpm ${pnpm}, wanted 11.1.1`);
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('pins ok');
