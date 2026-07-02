import * as vscode from 'vscode';
import {
  CursorSession,
  getAdminApiKey,
  resolveSession,
} from './auth';
import {
  ApiError,
  PlanInfo,
  RawUsageEvent,
  fetchAdminUsage,
  fetchDashboardUsage,
  fetchMe,
  fetchPricingMarkdown,
  fetchStripeProfile,
} from './api';

export interface UsageResult {
  events: RawUsageEvent[];
  authMode: 'admin' | 'session' | 'none';
  email?: string;
  plan?: PlanInfo;
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
      const [events, plan] = await Promise.all([
        fetchDashboardUsage(session, startMs, endMs),
        fetchStripeProfile(session).catch((e) => {
          this.log(`Plan lookup failed (non-fatal): ${e?.message || e}`);
          return undefined;
        }),
      ]);
      if (plan) this.log(`Plan: ${plan.membershipType}`);
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
 * Minimal event cost sum for the status bar; mirrors the webview normalize()
 * priority: token-based plans bill chargedCents, otherwise model token cost
 * (tokenUsage.totalCents + cursorTokenFee), otherwise chargedCents.
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
