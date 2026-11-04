import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FsLedgerStore,
  Ledger,
  LedgerCorrupt,
  loadLedger,
  MemLedgerStore,
} from '../../../src/ledger/ledger.ts';

const NOW = () => '2026-01-01T00:00:00.000Z';

function build(store: MemLedgerStore | FsLedgerStore, n = 3) {
  const l = new Ledger(store, 'run', NOW);
  for (let i = 0; i < n; i++) l.append('heartbeat', null, { i });
}

describe('ledger', () => {
  it('builds a chain that verifies', () => {
    const s = new MemLedgerStore();
    build(s);
    const { events, tornTail } = loadLedger(s);
    expect(events.length).toBe(3);
    expect(tornTail).toBe(false);
    expect(events[1].prev).toBe(events[0].hash);
  });
  it('fails on an edited line', () => {
    const s = new MemLedgerStore();
    build(s);
    s.content = s.content.replace('"i":1', '"i":9');
    expect(() => loadLedger(s)).toThrow(LedgerCorrupt);
  });
  it('fails on a removed middle line', () => {
    const s = new MemLedgerStore();
    build(s);
    const lines = s.content.split('\n');
    lines.splice(1, 1);
    s.content = lines.join('\n');
    expect(() => loadLedger(s)).toThrow(LedgerCorrupt);
  });
  it('fails on a garbage middle line', () => {
    const s = new MemLedgerStore();
    build(s);
    const lines = s.content.split('\n');
    lines[1] = '{"torn';
    s.content = lines.join('\n');
    expect(() => loadLedger(s)).toThrow(LedgerCorrupt);
  });
  it('recovers a truncated final line, and appends after it', () => {
    const s = new MemLedgerStore();
    build(s);
    s.content = s.content.slice(0, -20);
    const { events, tornTail } = loadLedger(s);
    expect(tornTail).toBe(true);
    expect(events.length).toBe(2);
    const l = new Ledger(s, 'run', NOW, events);
    l.append('ledger.torn_tail_recovered', null, {});
    expect(loadLedger(s).events.length).toBe(3);
  });
  it('recovers a torn tail on disk', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ecp-ledger-')), 'ledger', 'events.jsonl');
    const s = new FsLedgerStore(p);
    build(s);
    writeFileSync(p, readFileSync(p, 'utf8').slice(0, -5));
    const { events, tornTail } = loadLedger(s);
    expect(tornTail).toBe(true);
    expect(events.length).toBe(2);
    expect(readFileSync(p, 'utf8').endsWith('\n')).toBe(true);
  });
  it('treats an empty ledger as empty', () => {
    expect(loadLedger(new MemLedgerStore()).events).toEqual([]);
  });
});
