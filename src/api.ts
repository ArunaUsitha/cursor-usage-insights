import { CursorSession } from './authCore';

/** Shape the webview's normalize() consumes (same as the original web app). */
export interface RawUsageEvent {
  id: string;
  timestamp: number | string;
  model: string;
  kind?: string;
  isTokenBasedCall: boolean;
  chargedCents: number | null;
  cursorTokenFee: number | null;
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalCents?: number;
  } | null;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 500;
const USER_AGENT = 'cursor-usage-dashboard-extension';

async function fetchJson(url: string, options: RequestInit, timeoutMs = 20000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status);
    }
    return data;
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    if (e?.name === 'AbortError') throw new ApiError(`Request timed out: ${url}`);
    throw new ApiError(e?.message || String(e));
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse cost fields that may arrive as cents, "$0.04", "0.04", or "-". */
function toCents(v: unknown): number | null {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/([\d.]+)/);
  if (!m) return null;
  const parsed = parseFloat(m[1]);
  if (!Number.isFinite(parsed)) return null;
  // Strings on these endpoints are dollar amounts; numbers are cents.
  return Math.round(parsed * 100 * 1000) / 1000;
}

function pickChargedCents(e: any): number | null {
  if (e.chargedCents != null) return num(e.chargedCents);
  const usageBased = toCents(e.usageBasedCosts);
  if (usageBased != null) return usageBased;
  return toCents(e.requestsCosts);
}

export function toRawEvent(e: any): RawUsageEvent {
  const tu = e.tokenUsage || null;
  return {
    id: String(e.id ?? e.eventId ?? `${e.timestamp}-${e.model ?? 'unknown'}`),
    timestamp: e.timestamp ?? e.timestampEpoch ?? 0,
    model: e.model || e.modelIntent || 'unknown',
    kind: e.kind || e.kindLabel,
    isTokenBasedCall: Boolean(e.isTokenBasedCall),
    chargedCents: pickChargedCents(e),
    cursorTokenFee: num(e.cursorTokenFee ?? tu?.cursorTokenFee),
    tokenUsage: tu
      ? {
          inputTokens: num(tu.inputTokens) ?? 0,
          outputTokens: num(tu.outputTokens) ?? 0,
          cacheReadTokens: num(tu.cacheReadTokens) ?? 0,
          cacheWriteTokens: num(tu.cacheWriteTokens) ?? 0,
          totalCents: num(tu.totalCents) ?? undefined,
        }
      : null,
  };
}

/** Personal usage via the cursor.com dashboard API (session cookie auth). */
export async function fetchDashboardUsage(
  session: CursorSession,
  startMs: number,
  endMs: number,
): Promise<RawUsageEvent[]> {
  const events: RawUsageEvent[] = [];
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const data = await fetchJson('https://cursor.com/api/dashboard/get-filtered-usage-events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
      },
      body: JSON.stringify({
        teamId: 0,
        startDate: String(startMs),
        endDate: String(endMs),
        page,
        pageSize: PAGE_SIZE,
      }),
    });

    const batch: any[] = data.usageEventsDisplay || data.usageEvents || data.events || [];
    events.push(...batch.map(toRawEvent));

    const total = num(data.totalUsageEventsCount);
    const hasNext =
      data.pagination?.hasNextPage ??
      (total != null ? page * PAGE_SIZE < total : batch.length === PAGE_SIZE);
    if (!batch.length || !hasNext) break;
  }

  return events;
}

/** Team usage via the official Admin API (Basic auth with an admin key). */
export async function fetchAdminUsage(
  apiKey: string,
  startMs: number,
  endMs: number,
): Promise<RawUsageEvent[]> {
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const events: RawUsageEvent[] = [];
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const data = await fetchJson('https://api.cursor.com/teams/filtered-usage-events', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ startDate: startMs, endDate: endMs, page, pageSize: PAGE_SIZE }),
    });

    const batch: any[] = data.usageEvents || data.events || [];
    events.push(...batch.map(toRawEvent));

    const hasNext = data.pagination?.hasNextPage ?? batch.length === PAGE_SIZE;
    if (!batch.length || !hasNext) break;
  }

  return events;
}

/** Validates the session and returns account info. */
export async function fetchMe(session: CursorSession): Promise<{ email?: string; name?: string }> {
  const data = await fetchJson('https://cursor.com/api/auth/me', {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
  });
  return { email: data?.email, name: data?.name };
}

/** Model pricing docs as markdown; the webview's parsePricing consumes it. */
export async function fetchPricingMarkdown(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch('https://cursor.com/docs/models-and-pricing.md', {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(`Pricing fetch failed: HTTP ${res.status}`, res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
