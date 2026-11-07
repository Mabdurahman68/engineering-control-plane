import { sha256 } from '../ledger/canonical.ts';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const CLOCK = /\b\d{1,2}:\d{2}:\d{2}\b/g;
const DURATION = /\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|mins)\b/g;
const HEX_ADDR = /\b0x[0-9a-fA-F]+\b/g;
const ABS_PATH = /(^|[\s'"(=])(\/[^\s'":)]+\/)/g;

export function normaliseLines(log: string): string[] {
  const clean = log
    .replace(ANSI, '')
    .replace(TIMESTAMP, '')
    .replace(CLOCK, '')
    .replace(DURATION, '')
    .replace(HEX_ADDR, '')
    .replace(ABS_PATH, '$1');
  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const keep = lines.filter((l) => /error|fail|assert/i.test(l));
  return (keep.length ? keep : lines.slice(-20)).sort();
}

export function gateSignature(gateId: string, log: string): string {
  return sha256(`${gateId}\n${normaliseLines(log).join('\n')}`);
}
