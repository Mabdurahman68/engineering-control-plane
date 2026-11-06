import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { EventType, LedgerEvent } from '../contracts/index.ts';
import { eventSchema } from '../contracts/index.ts';
import { canonical, sha256 } from './canonical.ts';

export class LedgerCorrupt extends Error {}

export function eventHash(prev: string, ev: Omit<LedgerEvent, 'hash'>): string {
  return sha256(prev + canonical(ev));
}

export interface LedgerStore {
  // Durable before it returns: the write-ahead rule depends on it.
  appendRaw(line: string): void;
  readRaw(): string;
  truncateTo(bytes: number): void;
}

export class MemLedgerStore implements LedgerStore {
  content = '';
  appendRaw(line: string) {
    this.content += line;
  }
  readRaw() {
    return this.content;
  }
  truncateTo(bytes: number) {
    this.content = Buffer.from(this.content).subarray(0, bytes).toString();
  }
}

export class LedgerReadOnly extends Error {}

// A coordinator's store checks ownership before every mutation, append and repair alike. A reader's
// store can't mutate at all, and creates nothing: no directory comes from opening one.
export class FsLedgerStore implements LedgerStore {
  private readonly path: string;
  private readonly guard: (() => void) | null;
  private readonly readOnly: boolean;
  constructor(path: string, o: { guard?: () => void; readOnly?: boolean } = {}) {
    this.path = path;
    this.guard = o.guard ?? null;
    this.readOnly = o.readOnly ?? false;
  }
  private mutating() {
    if (this.readOnly) throw new LedgerReadOnly(`${this.path} is open read-only`);
    this.guard?.();
  }
  appendRaw(line: string) {
    this.mutating();
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  readRaw() {
    return existsSync(this.path) ? readFileSync(this.path, 'utf8') : '';
  }
  truncateTo(bytes: number) {
    this.mutating();
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  appendForTest(text: string) {
    appendFileSync(this.path, text);
  }
}

export type LoadResult = { events: LedgerEvent[]; tornTail: boolean };

// Reads and verifies the chain. Only a truncated final line is recoverable; any other break throws.
// The coordinator repairs a torn tail; a reader leaves the file alone and ignores the tail in memory.
export function loadLedger(store: LedgerStore, o: { repair?: boolean } = {}): LoadResult {
  const raw = store.readRaw();
  if (raw === '') return { events: [], tornTail: false };
  const endsClean = raw.endsWith('\n');
  const lines = raw.split('\n');
  const tail = lines.pop() as string;
  let tornTail = false;
  if (!endsClean) {
    let parsesWhole = false;
    try {
      JSON.parse(tail);
      parsesWhole = true;
    } catch {
      parsesWhole = false;
    }
    if (parsesWhole) throw new LedgerCorrupt('final line complete JSON without a newline');
    tornTail = true;
    if (o.repair !== false) store.truncateTo(Buffer.byteLength(raw) - Buffer.byteLength(tail));
  }
  const events: LedgerEvent[] = [];
  let prev = '';
  lines.forEach((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LedgerCorrupt(`line ${i + 1} is not JSON`);
    }
    const res = eventSchema.safeParse(parsed);
    if (!res.success) throw new LedgerCorrupt(`line ${i + 1} fails the event schema`);
    const ev = res.data;
    if (ev.seq !== i) throw new LedgerCorrupt(`line ${i + 1} has seq ${ev.seq}`);
    if (ev.prev !== prev) throw new LedgerCorrupt(`line ${i + 1} breaks the chain`);
    const { hash, ...body } = ev;
    if (eventHash(prev, body) !== hash) throw new LedgerCorrupt(`line ${i + 1} has a bad hash`);
    prev = hash;
    events.push(ev);
  });
  return { events, tornTail };
}

export class Ledger {
  readonly store: LedgerStore;
  readonly runId: string;
  private seq: number;
  private prev: string;
  private readonly now: () => string;
  constructor(store: LedgerStore, runId: string, now: () => string, existing: LedgerEvent[] = []) {
    this.store = store;
    this.runId = runId;
    this.now = now;
    this.seq = existing.length;
    this.prev = existing.length ? existing[existing.length - 1].hash : '';
  }
  append(type: EventType, taskId: string | null, data: Record<string, unknown>): LedgerEvent {
    const body = {
      schema: 'event.v1' as const,
      seq: this.seq,
      at: this.now(),
      run_id: this.runId,
      task_id: taskId,
      type,
      data,
      prev: this.prev,
    };
    // Round-trip so the hash always covers what a replay will read back.
    const clean = JSON.parse(JSON.stringify(body));
    const ev: LedgerEvent = { ...clean, hash: eventHash(this.prev, clean) };
    this.store.appendRaw(`${JSON.stringify(ev)}\n`);
    this.seq += 1;
    this.prev = ev.hash;
    return ev;
  }
}
