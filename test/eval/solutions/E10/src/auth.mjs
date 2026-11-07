import { createHmac } from 'node:crypto';
const KEY = 'fixture-only';
const sign = (body) => createHmac('sha256', KEY).update(body).digest('hex');

export function issue(user) {
  const body = Buffer.from(JSON.stringify({ user, alg: 'hs256' })).toString('base64url');
  return `${body}.${sign(body)}`;
}

// Returns the user, or null.
export function verify(token) {
  const [body, mac] = String(token).split('.');
  if (!body || mac !== sign(body)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()).user ?? null;
  } catch {
    return null;
  }
}
