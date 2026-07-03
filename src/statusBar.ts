import * as vscode from 'vscode';
import { UsageService, sumBilledCostDollars, sumTokenCostDollars } from './service';

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
    const { enabled, periodDays, costMode } = this.config();
    if (!enabled) return;

    try {
      const { start, end } = dayWindow(periodDays);
      const result = await this.service.getUsage(start, end);

      if (result.authMode === 'none') {
        this.item.text = '$(graph) Cursor Usage';
        this.item.tooltip = 'Cursor Usage: sign into Cursor (or set a session token) to load data. Click to open the dashboard.';
        return;
      }

      const freePlan = result.plan?.membershipType?.startsWith('free') ?? false;
      const cost = costMode === 'billed'
        ? sumBilledCostDollars(result.events, result.plan)
        : sumTokenCostDollars(result.events);
      const showWhatIfPrefix = costMode === 'value' && freePlan;
      this.item.text = `$(graph) ${showWhatIfPrefix ? '~' : ''}$${cost.toFixed(2)}`;

      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`**Cursor Usage** — last ${periodDays} days\n\n`);
      const costLabel = costMode === 'billed'
        ? 'Billed cost'
        : `Token ${freePlan ? 'value (what-if, not billed)' : 'cost'}`;
      tooltip.appendMarkdown(`- ${costLabel}: **$${cost.toFixed(2)}**\n`);
      tooltip.appendMarkdown(`- Requests: **${result.events.length.toLocaleString('en-US')}**\n`);
      if (result.plan?.membershipType) tooltip.appendMarkdown(`- Plan: ${result.plan.membershipType}\n`);
      if (result.email) tooltip.appendMarkdown(`- Account: ${result.email}\n`);
      tooltip.appendMarkdown(`\n_Click to open the dashboard._`);
      this.item.tooltip = tooltip;
    } catch (e: any) {
      this.item.text = '$(graph) Cursor Usage';
      this.item.tooltip = `Cursor Usage: ${e?.message || 'failed to load'} — click to open the dashboard.`;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
