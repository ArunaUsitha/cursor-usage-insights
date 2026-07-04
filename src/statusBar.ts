import * as vscode from 'vscode';
import { UsageService, countRequests, projectExhaustionDate, quotaPercentUsed, statusBarText, sumBilledCostDollars, sumTokenCostDollars } from './service';

type CostMode = 'value' | 'billed';

/** Calendar-day window matching the dashboard's date presets (not a raw ms rollback). */
function dayWindow(periodDays: number): { start: number; end: number } {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (periodDays - 1));
  return { start: start.getTime(), end: end.getTime() };
}

export class UsageStatusBar {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly service: UsageService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'cursorUsage.openDashboard';
    this.item.text = '$(graph) Cursor Usage';
    this.item.tooltip = 'Cursor Usage: loading…';

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cursorUsage')) this.applyConfig();
      }),
    );
    this.applyConfig();
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration('cursorUsage');
    const costMode = cfg.get<string>('statusBar.costMode', 'value');
    return {
      enabled: cfg.get<boolean>('statusBar.enabled', true),
      intervalMinutes: Math.max(5, cfg.get<number>('refreshIntervalMinutes', 15)),
      periodDays: Math.min(90, Math.max(1, cfg.get<number>('statusBar.periodDays', 30))),
      costMode: (costMode === 'billed' ? 'billed' : 'value') as CostMode,
      warnAtPercent: Math.min(99, Math.max(1, cfg.get<number>('statusBar.warnAtPercent', 80))),
      criticalAtPercent: Math.min(200, Math.max(1, cfg.get<number>('statusBar.criticalAtPercent', 95))),
    };
  }

  private applyConfig(): void {
    const { enabled, intervalMinutes } = this.config();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    if (!enabled) {
      this.item.hide();
      return;
    }
    this.item.show();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMinutes * 60 * 1000);
  }

  async refresh(): Promise<void> {
    const { enabled, periodDays, costMode, warnAtPercent, criticalAtPercent } = this.config();
    if (!enabled) return;

    try {
      const { start, end } = dayWindow(periodDays);
      const result = await this.service.getUsage(start, end);

      if (result.authMode === 'none') {
        this.item.text = '$(graph) Cursor Usage';
        this.item.tooltip = 'Cursor Usage: sign into Cursor (or set a session token) to load data. Click to open the dashboard.';
        this.item.backgroundColor = undefined;
        return;
      }

      const freePlan = result.plan?.membershipType?.startsWith('free') ?? false;
      const billed = sumBilledCostDollars(result.events, result.plan);
      const cost = costMode === 'billed' ? billed : sumTokenCostDollars(result.events);
      const showWhatIfPrefix = costMode === 'value' && freePlan;

      const quota = result.quota;
      const quotaPct = quotaPercentUsed(quota);
      const hasQuotaLimit = quotaPct != null;
      let severity: 'normal' | 'warning' | 'critical' = 'normal';
      if (quotaPct != null) {
        if (quotaPct >= criticalAtPercent) severity = 'critical';
        else if (quotaPct >= warnAtPercent) severity = 'warning';
      }
      this.item.backgroundColor =
        severity === 'critical'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : severity === 'warning'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;

      const icon = severity === 'critical' ? '$(warning)' : severity === 'warning' ? '$(alert)' : '$(graph)';
      this.item.text = `${icon} ${statusBarText({ quota, costDollars: cost, onDemandDollars: billed, showWhatIfPrefix })}`;

      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`**Cursor Usage** — last ${periodDays} days\n\n`);
      const costLabel = costMode === 'billed'
        ? 'Billed cost'
        : `Token ${freePlan ? 'value (what-if, not billed)' : 'cost'}`;
      tooltip.appendMarkdown(`- ${costLabel}: **$${cost.toFixed(2)}**\n`);
      tooltip.appendMarkdown(`- Requests: **${countRequests(result.events).toLocaleString('en-US')}**\n`);
      if (result.plan?.membershipType) tooltip.appendMarkdown(`- Plan: ${result.plan.membershipType}\n`);
      if (quota && hasQuotaLimit) {
        const overLimit = quota.used > quota.limit!;
        tooltip.appendMarkdown(
          overLimit
            ? `- Plan usage: **${quota.used.toLocaleString('en-US')} / ${quota.limit!.toLocaleString('en-US')} · limit reached** (${quotaPct!.toFixed(0)}%)\n`
            : `- Plan usage: **${quota.used.toLocaleString('en-US')} / ${quota.limit!.toLocaleString('en-US')}** (${quotaPct!.toFixed(0)}%)\n`,
        );
        if (quota.used >= quota.limit!) {
          tooltip.appendMarkdown(`- On-demand usage (last ${periodDays} days): **$${billed.toFixed(2)}**\n`);
        }
        if (quota.resetIso) {
          const resetDate = new Date(quota.resetIso);
          if (!Number.isNaN(resetDate.getTime())) {
            tooltip.appendMarkdown(`- Resets: ${resetDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}\n`);
          }
        }
        if (quota.startOfCycleIso) {
          const sinceMs = new Date(quota.startOfCycleIso).getTime();
          if (!Number.isNaN(sinceMs)) {
            const exhaustion = projectExhaustionDate(quota.used, quota.limit, sinceMs);
            if (exhaustion) {
              const days = Math.max(0, Math.round((exhaustion.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
              tooltip.appendMarkdown(
                days <= 0
                  ? `- ⚠️ At this pace, you've already used your plan's included requests for this cycle\n`
                  : `- At this pace: **~${days} day${days === 1 ? '' : 's'}** until included requests run out\n`,
              );
            }
          }
        }
      } else if (quota && quota.used > 0) {
        tooltip.appendMarkdown(`- Plan usage: **${quota.used.toLocaleString('en-US')}** requests this cycle (no fixed limit found)\n`);
      } else if (quota) {
        tooltip.appendMarkdown(
          `- No fixed request quota found for this plan — usage like Auto is metered by token cost above, not a request count\n`,
        );
      }
      if (result.hardLimit) {
        tooltip.appendMarkdown(`- Spend cap: **$${result.hardLimit.toFixed(2)}**/mo (see dashboard for cycle-to-date billed total)\n`);
      }
      if (result.email) tooltip.appendMarkdown(`- Account: ${result.email}\n`);
      tooltip.appendMarkdown(`\n_Click to open the dashboard._`);
      this.item.tooltip = tooltip;
    } catch (e: any) {
      this.item.text = '$(graph) Cursor Usage';
      this.item.tooltip = `Cursor Usage: ${e?.message || 'failed to load'} — click to open the dashboard.`;
      this.item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
