import * as vscode from 'vscode';
import {
  CursorSession,
  getAdminApiKey,
  resolveSession,
} from './auth';
import {
  ApiError,
  PlanInfo,
  PlanQuota,
  RawUsageEvent,
  fetchAdminUsage,
  fetchDashboardUsage,
  fetchHardLimit,
  fetchMe,
  fetchPlanQuota,
  fetchPricingMarkdown,
  fetchStripeProfile,
} from './api';

export interface UsageResult {
  events: RawUsageEvent[];
  authMode: 'admin' | 'session' | 'none';
  email?: string;
  plan?: PlanInfo;
  quota?: PlanQuota;
  hardLimit?: number | null;
  note?: string;
}

/**
 * Shared data layer for the dashboard panel and the status bar. Mirrors the
 * original server.js auth priority: Admin API key -> Cursor IDE session ->
 * none.
 */
export class UsageService {
  private pricingCache: { markdown: string; fetchedAt: number } | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  async getSession(): Promise<CursorSession | null> {
    const session = await resolveSession(this.context);
    this.log(session
      ? `Session resolved (source: ${session.source}, user: ${session.userId}${session.email ? `, email: ${session.email}` : ''})`
      : 'No Cursor session found (state.vscdb unreadable or missing token, no manual token stored)');
    return session;
  }

  async getStatus(): Promise<{ authMode: 'admin' | 'session' | 'none'; email?: string }> {
    if (await getAdminApiKey(this.context)) return { authMode: 'admin' };
    const session = await this.getSession();
    if (session) return { authMode: 'session', email: session.email };
    return { authMode: 'none' };
  }

  async getUsage(startMs: number, endMs: number): Promise<UsageResult> {
    const adminKey = await getAdminApiKey(this.context);
    if (adminKey) {
      const events = await fetchAdminUsage(adminKey, startMs, endMs);
      return { events, authMode: 'admin', note: 'Team usage via Admin API.' };
    }

    const session = await this.getSession();
    if (session) {
      const [events, plan, quota, hardLimit] = await Promise.all([
        fetchDashboardUsage(session, startMs, endMs),
        fetchStripeProfile(session).catch((e) => {
          this.log(`Plan lookup failed (non-fatal): ${e?.message || e}`);
          return undefined;
        }),
        fetchPlanQuota(session).catch((e) => {
          this.log(`Quota lookup failed (non-fatal): ${e?.message || e}`);
          return undefined;
        }),
        fetchHardLimit(session).catch((e) => {
          this.log(`Hard-limit lookup failed (non-fatal): ${e?.message || e}`);
          return undefined;
        }),
      ]);
      if (plan) this.log(`Plan: ${plan.membershipType}`);
      if (quota) this.log(`Quota: ${quota.used}/${quota.limit ?? '∞'}`);
      if (hardLimit) this.log(`Hard limit: $${hardLimit}`);
      let email = session.email;
      if (!email) {
        try {
          email = (await fetchMe(session)).email;
        } catch {
          // Non-fatal: usage already loaded.
        }
      }
      return {
        events,
        authMode: 'session',
        email,
        plan,
        quota: quota ?? undefined,
        hardLimit,
        note:
          session.source === 'ide'
            ? 'Signed in with your Cursor IDE session.'
            : 'Using manually stored session token.',
      };
    }

    return { events: [], authMode: 'none' };
  }

  /** Pricing markdown, cached for an hour (it changes rarely). */
  async getPricingMarkdown(): Promise<string> {
    const ONE_HOUR = 60 * 60 * 1000;
    if (this.pricingCache && Date.now() - this.pricingCache.fetchedAt < ONE_HOUR) {
      return this.pricingCache.markdown;
    }
    const markdown = await fetchPricingMarkdown();
    this.pricingCache = { markdown, fetchedAt: Date.now() };
    return markdown;
  }

  isAuthError(e: unknown): boolean {
    return e instanceof ApiError && (e.status === 401 || e.status === 403);
  }
}

/**
 * What-if event cost sum for the status bar; mirrors the webview normalize()
 * priority: token-based plans bill chargedCents, otherwise model token cost
 * (tokenUsage.totalCents + cursorTokenFee), otherwise chargedCents. This is
 * the API-equivalent value of the tokens, not what the user was actually
 * charged — see sumBilledCostDollars for that.
 */
export function sumTokenCostDollars(events: RawUsageEvent[]): number {
  let cents = 0;
  for (const e of events) {
    const modelCents =
      e.tokenUsage?.totalCents != null
        ? e.tokenUsage.totalCents + (e.cursorTokenFee ?? 0)
        : null;
    if (e.isTokenBasedCall && e.chargedCents != null) cents += e.chargedCents;
    else if (modelCents != null) cents += modelCents;
    else if (e.chargedCents != null) cents += e.chargedCents;
  }
  return cents / 100;
}

const FREE_KIND_RE = /included|free|not charged|no charge|errored/i;

/**
 * Actually-billed cost sum; ports the webview logic.js normalize() billedCost
 * rule so the status bar can show it without depending on the webview: free
 * plans are never billed, included/free/errored events are always 0, and
 * everything else bills chargedCents.
 */
export function sumBilledCostDollars(events: RawUsageEvent[], plan?: PlanInfo): number {
  const freePlan = plan?.membershipType?.startsWith('free') ?? false;
  if (freePlan) return 0;

  let cents = 0;
  for (const e of events) {
    if (e.kind && FREE_KIND_RE.test(e.kind)) continue;
    if (e.chargedCents != null) cents += e.chargedCents;
  }
  return cents / 100;
}

/**
 * Straight-line projection of when `used` will hit `limit`, from the average
 * daily pace since `sinceMs`. Returns null when there's no limit, no usage
 * yet, or the pace is already flat/negative (can't extrapolate).
 */
export function projectExhaustionDate(
  used: number,
  limit: number | null | undefined,
  sinceMs: number,
  nowMs: number = Date.now(),
): Date | null {
  if (limit == null || limit <= 0 || used <= 0) return null;
  const elapsedDays = (nowMs - sinceMs) / (24 * 60 * 60 * 1000);
  if (elapsedDays < 0.5) return null;
  const perDay = used / elapsedDays;
  if (perDay <= 0) return null;
  const remaining = limit - used;
  if (remaining <= 0) return new Date(nowMs);
  const daysLeft = remaining / perDay;
  return new Date(nowMs + daysLeft * 24 * 60 * 60 * 1000);
}
