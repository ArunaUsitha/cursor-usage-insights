# Cursor Usage Dashboard

**See exactly where your Cursor requests and tokens go — right inside Cursor.**

[![Open VSX](https://img.shields.io/open-vsx/v/iair0007/cursor-usage-dashboard?label=Open%20VSX)](https://open-vsx.org/extension/iair0007/cursor-usage-dashboard)
[![Downloads](https://img.shields.io/open-vsx/dt/iair0007/cursor-usage-dashboard)](https://open-vsx.org/extension/iair0007/cursor-usage-dashboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/iair0007/cursor-usage/blob/main/LICENSE)

**Website:** [iair0007.github.io/cursor-usage](https://iair0007.github.io/cursor-usage/)

Costs, cache savings, model breakdowns, rule-based insights, and a cost simulator — with zero setup. No proxy server, no login: it reuses the session Cursor created when you signed in.

![Overview tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-overview.png)

## Install

1. Open the Extensions view in Cursor (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **"Cursor Usage Dashboard"** and click **Install**.
3. Run **`Cursor Usage: Open Dashboard`** from the command palette — that's it.

The extension is published on the [Open VSX Registry](https://open-vsx.org/extension/iair0007/cursor-usage-dashboard), which is what Cursor's Extensions view searches.

## Always-on status bar

A live usage figure sits in your status bar and updates automatically. Click it to open the dashboard, or click the gear icon next to it to open settings.

![Status bar states](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-statusbar.png)

- **On plans with included requests** (e.g. 500/month) it shows **requests used vs. your limit** — `110/500` — because that's the number you actually watch on those plans.
- It turns **yellow at 80%** and **red at 95%** of your quota (both thresholds configurable), and the tooltip projects when you'll run out at your current pace.
- **Once the quota is exhausted** it pins at `500/500` and appends your **on-demand spend** — so you see immediately that you're now paying per use, and how much.
- **On token-metered plans** (no request quota) it shows your token cost for the last 30 days (configurable).

## What's inside

The dashboard has four tabs, from simple to detailed:

### Overview

Your plan and billing-cycle status with a progress bar and burn-rate projection, three key numbers (cost, requests, cache savings), a daily-spend sparkline, and the single most important insight right now. A **What-if / Billed** toggle switches every figure between the API-equivalent value of your tokens and what you were actually charged.

### Requests

![Requests tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-requests.png)

The full request log: custom date ranges, model filter, per-request token cost and cache savings, expensive-request highlighting, sortable columns, CSV export. The **Analytics** sub-tab adds daily token cost, cost by model, and token volume charts with a week-over-week trend badge.

![Analytics charts](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-analytics.png)

### Analyze

![Analyze tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-analyze.png)

Rule-based findings with configurable thresholds: which model dominates your spend, whether your cache is working, cold starts, heavy-output requests, spike requests — each with a concrete "what to do about it". The **Ask Cursor Chat** panel builds a compact brief from the data slices you pick, copies it, and focuses Cursor's chat so you just paste and send.

### Simulator

![Simulator tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-simulator.png)

Replay any real request's token profile against other models' published rates — *"what would this request have cost on Haiku?"* — or price a custom token profile from scratch.

## Commands

| Command | Description |
| --- | --- |
| `Cursor Usage: Open Dashboard` | Open the dashboard panel |
| `Cursor Usage: Refresh` | Reload usage data (dashboard + status bar) |
| `Cursor Usage: Set Session Token Manually` | Fallback auth via pasted cookie |
| `Cursor Usage: Set Team Admin API Key` | Team usage via the Admin API |
| `Cursor Usage: Clear Stored Credentials` | Delete stored secrets |
| `Cursor Usage: Show Logs` | Open the extension's output channel |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorUsage.statusBar.enabled` | `true` | Show usage in the status bar |
| `cursorUsage.statusBar.costMode` | `value` | What-if token value vs. actually billed cost |
| `cursorUsage.refreshIntervalMinutes` | `15` | Status bar refresh cadence |
| `cursorUsage.statusBar.periodDays` | `30` | Days covered by the status bar figure |
| `cursorUsage.statusBar.warnAtPercent` | `80` | Quota % at which the status bar turns yellow |
| `cursorUsage.statusBar.criticalAtPercent` | `95` | Quota % at which the status bar turns red |

## Authentication & privacy

Everything runs locally — the only network calls are to cursor.com. Auth is resolved in this order:

1. **Cursor IDE session (default, zero setup)** — Cursor stores your session token in its local `state.vscdb` database when you sign in. The extension reads it *read-only*, preferring the native `sqlite3` CLI (streams from disk, so it works even on multi-GB databases) with a bundled WebAssembly SQLite fallback for small files.
2. **Team Admin API key** — run *"Cursor Usage: Set Team Admin API Key"* (Teams/Business plans) for team-wide usage via the official Admin API.
3. **Manual session token** — run *"Cursor Usage: Set Session Token Manually"* and paste the `WorkosCursorSessionToken` cookie from cursor.com (DevTools → Application → Cookies).

Secrets are stored in VS Code SecretStorage (your OS keychain), never in settings files. *"Cursor Usage: Clear Stored Credentials"* removes them.

## Troubleshooting

- **"Not signed in" but you are** — make sure you're logged into Cursor itself (Settings → Account). As a last resort, set a session token manually (see above).
- **Huge `state.vscdb`** — the extension reads it with the `sqlite3` CLI, which handles multi-GB files. `sqlite3` ships preinstalled on macOS and virtually every Linux distro; on Windows it's usually present too (`winget install SQLite.SQLite` otherwise). If the logs show `Skipping WASM SQLite fallback ... too large for sql.js`, install the CLI and reload the window.
- **Something looks off** — run `Cursor Usage: Show Logs` and check the output channel.

## Good to know

- The personal-usage endpoints (`cursor.com/api/dashboard/*`) are **unofficial** — Cursor can change them at any time. Each data source degrades gracefully; the Admin API path uses the documented official API.
- Cache savings are **estimates**: cache-read tokens × (input rate − cache-read rate) at published per-model pricing. Simulator numbers are directional (same tokens, different rates), not quotes.
- If cursor.com's pricing page can't be reached, the dashboard falls back to a small bundled rate table (clearly flagged) instead of breaking cost estimates.

## Contributing

Issues and PRs are welcome at [iair0007/cursor-usage](https://github.com/iair0007/cursor-usage).

```bash
npm install
npm run compile   # type-check + bundle
npm test          # unit tests
npm run watch     # rebuild on change
npm run package   # build a local .vsix (Extensions: Install from VSIX…)
```

Layout: `src/extension.ts` (activation), `src/auth.ts` + `src/authCore.ts` (session resolution), `src/api.ts` (cursor.com client), `src/service.ts` (shared data layer), `src/panel.ts` + `src/html.ts` (webview + RPC bridge), `src/statusBar.ts`, `src/webview/` (dashboard UI).

Releases are automated: bumping `version` in `package.json` on `main` triggers the [publish workflow](https://github.com/iair0007/cursor-usage/blob/main/.github/workflows/publish.yml), which builds the `.vsix` and publishes it to Open VSX.

## License

[MIT](https://github.com/iair0007/cursor-usage/blob/main/LICENSE)
