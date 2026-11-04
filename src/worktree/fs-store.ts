import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunStore } from './port.ts';

export class FsRunStore implements RunStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  write(rel: string, content: string) {
    const p = join(this.root, rel);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, p);
  }
  read(rel: string) {
    const p = join(this.root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  exists(rel: string) {
    return existsSync(join(this.root, rel));
  }
  list(rel: string) {
    const p = join(this.root, rel);
    return existsSync(p) ? readdirSync(p).sort() : [];
  }
  path(rel: string) {
    return join(this.root, rel);
  }
}

export class MemRunStore implements RunStore {
  readonly files = new Map<string, string>();
  write(rel: string, content: string) {
    this.files.set(rel, content);
  }
  read(rel: string) {
    return this.files.get(rel) ?? null;
  }
  exists(rel: string) {
    return this.files.has(rel);
  }
  list(rel: string) {
    const pre = rel.endsWith('/') ? rel : `${rel}/`;
    return [...this.files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
  }
  path(rel: string) {
    return `/mem/${rel}`;
  }
}
