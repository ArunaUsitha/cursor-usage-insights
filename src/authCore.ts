// Pure auth helpers — no vscode dependency so they can be unit-tested.

export interface CursorSession {
  /** Value of the WorkosCursorSessionToken cookie: `{userId}%3A%3A{jwt}` */
  cookieValue: string;
  userId: string;
  email?: string;
  source: 'ide' | 'manual';
}

export interface JwtPayload {
  sub?: string;
  exp?: number;
  [key: string]: unknown;
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** `auth0|user_XXXX` -> `user_XXXX` */
export function userIdFromSub(sub: string): string {
  const idx = sub.indexOf('|');
  return idx >= 0 ? sub.slice(idx + 1) : sub;
}

export function buildCookieValue(userId: string, token: string): string {
  return `${userId}%3A%3A${token}`;
}

/**
 * Accepts what a user might paste for the manual fallback: the raw cookie
 * value (`user_x%3A%3Aey...` or `user_x::ey...`), a `name=value` pair, or a
 * bare JWT.
 */
export function normalizeManualToken(input: string): string | null {
  let v = input.trim();
  if (!v) return null;
  const eq = v.indexOf('=');
  if (v.toLowerCase().startsWith('workoscursorsessiontoken=')) v = v.slice(eq + 1).trim();
  v = v.replace(/::/g, '%3A%3A');
  if (v.includes('%3A%3A')) return v;
  // Bare JWT: derive the userId from its payload.
  const payload = decodeJwtPayload(v);
  if (payload?.sub) return buildCookieValue(userIdFromSub(payload.sub), v);
  return null;
}
