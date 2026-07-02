import * as vscode from 'vscode';
import { UsageService, sumTokenCostDollars } from './service';

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
    return {
      enabled: cfg.get<boolean>('statusBar.enabled', true),
      intervalMinutes: Math.max(5, cfg.get<number>('refreshIntervalMinutes', 15)),
      periodDays: Math.min(90, Math.max(1, cfg.get<number>('statusBar.periodDays', 30))),
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
    const { enabled, periodDays } = this.config();
    if (!enabled) return;

    try {
      const end = Date.now();
      const start = end - periodDays * 24 * 60 * 60 * 1000;
      const result = await this.service.getUsage(start, end);

      if (result.authMode === 'none') {
        this.item.text = '$(graph) Cursor Usage';
        this.item.tooltip = 'Cursor Usage: sign into Cursor (or set a session token) to load data. Click to open the dashboard.';
        return;
      }

      const cost = sumTokenCostDollars(result.events);
      this.item.text = `$(graph) $${cost.toFixed(2)}`;

      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`**Cursor Usage** — last ${periodDays} days\n\n`);
      tooltip.appendMarkdown(`- Token cost: **$${cost.toFixed(2)}**\n`);
      tooltip.appendMarkdown(`- Requests: **${result.events.length.toLocaleString('en-US')}**\n`);
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
