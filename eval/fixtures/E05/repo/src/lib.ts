export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
export function title(s: string): string {
  return s.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
