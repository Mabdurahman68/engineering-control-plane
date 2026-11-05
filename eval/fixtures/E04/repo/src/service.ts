export type Item = { id: string; name: string };
const items: Item[] = [
  { id: 'a1', name: 'first' },
  { id: 'b2', name: 'second' },
];

export function handle(method: string, path: string): { status: number; body: unknown } {
  if (method === 'GET' && path === '/items') return { status: 200, body: items };
  return { status: 404, body: { error: 'not_found' } };
}
