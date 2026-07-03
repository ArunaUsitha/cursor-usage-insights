import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import {
  CursorSession,
  buildCookieValue,
  decodeJwtPayload,
  normalizeManualToken,
  userIdFromSub,
} from './authCore';

export { CursorSession } from './authCore';

export type AuthMode = 'admin' | 'session' | 'none';

const SECRET_SESSION_TOKEN = 'cursorUsage.sessionToken';
const SECRET_ADMIN_API_KEY = 'cursorUsage.adminApiKey';

/**
 * Candidate locations of Cursor's global state DB. The extension usually runs
 * inside Cursor itself, so globalStorageUri points at
 * .../Cursor/User/globalStorage/<publisher.name> — its grandparent holds
 * state.vscdb regardless of platform or portable installs.
 */
export function candidateStateDbPaths(context: vscode.ExtensionContext): string[] {
  const candidates: string[] = [];

  const fromGlobalStorage = path.join(
    path.dirname(context.globalStorageUri.fsPath),
    'state.vscdb',
  );
  candidates.push(fromGlobalStorage);

  const home = os.homedir();
  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else {
    candidates.push(path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }

  return [...new Set(candidates)].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function readDbValues(dbFile: Buffer, wasmDir: string, keys: string[]): Promise<Map<string, string>> {
  return initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) }).then((SQL) => {
    const db = new SQL.Database(dbFile);
    const out = new Map<string, string>();
    try {
      const placeholders = keys.map(() => '?').join(',');
      const res = db.exec(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`, keys);
      for (const row of res[0]?.values ?? []) {
        out.set(String(row[0]), String(row[1]));
      }
    } finally {
      db.close();
    }
    return out;
  });
}

/**
 * Resolve the user's Cursor session, preferring the token Cursor itself
 * stored at login (zero-setup "SSO"), falling back to a manually stored one.
 */
export async function resolveSession(context: vscode.ExtensionContext): Promise<CursorSession | null> {
  const wasmDir = path.join(context.extensionUri.fsPath, 'media');

  for (const dbPath of candidateStateDbPaths(context)) {
    try {
      const buf = fs.readFileSync(dbPath);
      const values = await readDbValues(buf, wasmDir, [
        'cursorAuth/accessToken',
        'cursorAuth/cachedEmail',
      ]);
      const token = values.get('cursorAuth/accessToken');
      if (!token) continue;
      const payload = decodeJwtPayload(token);
      if (!payload?.sub) continue;
      if (payload.exp && payload.exp * 1000 < Date.now()) continue;
      const userId = userIdFromSub(payload.sub);
      return {
        cookieValue: buildCookieValue(userId, token),
        userId,
        email: values.get('cursorAuth/cachedEmail'),
        source: 'ide',
      };
    } catch {
      // Unreadable/locked DB — try the next candidate.
    }
  }

  const manual = await context.secrets.get(SECRET_SESSION_TOKEN);
  if (manual) {
    const userId = manual.split('%3A%3A')[0] || 'unknown';
    return { cookieValue: manual, userId, source: 'manual' };
  }

  return null;
}

export async function storeManualSessionToken(context: vscode.ExtensionContext, input: string): Promise<boolean> {
  const normalized = normalizeManualToken(input);
  if (!normalized) return false;
  await context.secrets.store(SECRET_SESSION_TOKEN, normalized);
  return true;
}

export async function getAdminApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_ADMIN_API_KEY);
}

export async function storeAdminApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_ADMIN_API_KEY, key.trim());
}

export async function clearStoredCredentials(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_SESSION_TOKEN);
  await context.secrets.delete(SECRET_ADMIN_API_KEY);
}
