export type Item = { id: string; name: string };
const items: Item[] = [
  { id: 'a1', name: 'first' },
  { id: 'b2', name: 'second' },
];

export function handle(method: string, path: string): { status: number; body: unknown } {
  if (method === 'GET' && path === '/items') return { status: 200, body: items };
  const m = /^\/items\/(.*)$/.exec(path);
  if (method === 'GET' && m) {
    if (!/^[A-Za-z0-9]+$/.test(m[1] as string)) return { status: 400, body: { error: 'bad_id' } };
    const item = items.find((i) => i.id === m[1]);
    if (item) return { status: 200, body: item };
  }
  return { status: 404, body: { error: 'not_found' } };
}
