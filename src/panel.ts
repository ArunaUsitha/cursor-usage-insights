import * as vscode from 'vscode';
import { UsageService } from './service';
import { UsageStatusBar } from './statusBar';
import { getDashboardHtml } from './html';

interface RpcMessage {
  type: 'rpc';
  id: number;
  method: string;
  params?: any;
}

export class DashboardPanel {
  public static current: DashboardPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, service: UsageService, statusBar?: UsageStatusBar): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'cursorUsageDashboard',
      'Cursor Usage',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    DashboardPanel.current = new DashboardPanel(panel, context, service, statusBar);
  }

  static refresh(): void {
    DashboardPanel.current?.panel.webview.postMessage({ type: 'refresh' });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly service: UsageService,
    private readonly statusBar?: UsageStatusBar,
  ) {
    panel.webview.html = getDashboardHtml(panel.webview, context.extensionUri);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'rpc') void this.handleRpc(msg as RpcMessage);
      },
      null,
      this.disposables,
    );
  }

  private async handleRpc(msg: RpcMessage): Promise<void> {
    try {
      const result = await this.dispatch(msg.method, msg.params || {});
      void this.panel.webview.postMessage({ type: 'rpc-result', id: msg.id, result });
    } catch (e: any) {
      const error = e?.message || String(e);
      const authError = this.service.isAuthError(e);
      void this.panel.webview.postMessage({ type: 'rpc-result', id: msg.id, error, authError });
      if (authError) this.offerTokenFix();
    }
  }

  private async dispatch(method: string, params: any): Promise<any> {
    switch (method) {
      case 'status':
        return this.service.getStatus();
      case 'usage': {
        const start = Number(params.startDate);
        const end = Number(params.endDate);
        if (!start || !end) throw new Error('startDate and endDate required (epoch ms)');
        const result = await this.service.getUsage(start, end);
        // Sync the status bar to whatever the user just saw, instead of
        // waiting for its own timer (avoids the two showing different counts).
        void this.statusBar?.refresh();
        return result;
      }
      case 'pricing':
        return { markdown: await this.service.getPricingMarkdown() };
      case 'copyText':
        await vscode.env.clipboard.writeText(String(params.text ?? ''));
        return { ok: true };
      case 'exportCsv':
        return this.saveCsv(String(params.csv ?? ''), String(params.filename || 'cursor-usage.csv'));
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async saveCsv(csv: string, filename: string): Promise<{ ok: boolean; path?: string }> {
    const defaultUri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(require('os').homedir()),
      filename,
    );
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { CSV: ['csv'] },
    });
    if (!uri) return { ok: false };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
    void vscode.window.showInformationMessage(`Exported usage CSV to ${uri.fsPath}`);
    return { ok: true, path: uri.fsPath };
  }

  private offerTokenFix(): void {
    void vscode.window
      .showWarningMessage(
        'Cursor Usage: authentication failed. Your Cursor session may have expired.',
        'Set Token Manually',
      )
      .then((pick) => {
        if (pick === 'Set Token Manually') {
          void vscode.commands.executeCommand('cursorUsage.setSessionToken');
        }
      });
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
