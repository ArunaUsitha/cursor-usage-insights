# Cursor Usage Dashboard (extension)

Analyze how you spend Cursor tokens — costs, cache savings, model breakdowns, rule-based insights, and a cost simulator — in a dashboard that runs **inside Cursor**.

This is the extension version of the standalone Cursor Usage Dashboard web app. Because it runs inside Cursor, there's no local proxy server and no login step: it reuses the session Cursor itself created when you signed in.

## Structure

The dashboard has four tabs, ordered from simple to detailed:

- **Overview** (default tab) — the simple main screen: your plan and billing-cycle status, three key numbers (cost, requests, cache savings), a small daily-spend sparkline, and the single most important insight, if any. A "What-if / Billed" and period toggle control the whole dashboard from here. One button ("View full request log & charts →") jumps to the details.
- **Requests** — the detailed view: full filter bar (custom date range, model filter), KPI strip, sortable/paginated request log with per-request cache savings and expensive-request highlighting, and an Analytics sub-tab (daily token cost, cost by model, token volume, with a week-over-week trend badge).
- **Analyze** — rule-based findings (model concentration, cache health, cold starts, heavy-output requests, spike requests) with **configurable thresholds**, spend-by-model and cache panels, top expensive requests, and an **"Ask Cursor Chat" brief builder**: pick a template + data scopes, then "Copy for Cursor Chat" copies a compact brief and (best-effort) brings Cursor's chat panel into focus, so you just paste and send. There's no supported API for extensions to populate or submit a prompt into Cursor's chat directly — pasting is always the last, explicit step, by design.
- **Simulator** — replay any real request's token profile against other models' published rates ("what would this request have cost on X?"), or price a custom token profile.

## Features

- **Plan-aware** — detects your plan (Free/Pro/Business/…) and shows a **What-if / Billed** cost toggle: What-if is the API-equivalent value of your tokens (useful for optimizing even on a plan where nothing is actually charged); Billed is what you were actually charged. A prominent **Plan & cycle** panel on the Overview tab shows a progress bar (used/limit + reset date + burn-rate projection) when Cursor reports a fixed request quota for your plan — and says so plainly when it doesn't (most Auto/token-metered usage isn't tracked by that legacy quota system, which is expected, not a bug).
- **Status bar** — live token cost for the last 30 days (configurable), color-coded (warning/error background) as you approach your plan's included-request limit, with a burn-rate projection ("~12 days until included requests run out") in the tooltip. Click to open the dashboard. Auto-refreshes, and also syncs immediately whenever you open/refresh the dashboard.
- Billing-mode aware: handles token-based plans, usage-based plans ($0.04/request-style flat fees shown separately from token cost), and mixed ranges after a plan change.
- CSV export, model filter, custom date ranges (Requests tab).
- Resilient pricing: if cursor.com's pricing page can't be reached or its layout changes, the dashboard falls back to a small bundled rate table (clearly flagged) instead of breaking cost estimates.

## How authentication works

Priority order (same as the original web app's proxy):

1. **Cursor IDE session (default, zero setup)** — Cursor stores your session token locally in its `state.vscdb` database when you sign in. The extension reads it (read-only, via WebAssembly SQLite — no native deps) and calls the same cursor.com dashboard APIs the official usage page uses.
2. **Team Admin API key** — run *"Cursor Usage: Set Team Admin API Key"* (requires a Teams/Business plan) to see team-wide usage via the official Admin API.
3. **Manual session token** — if the local DB can't be read, run *"Cursor Usage: Set Session Token Manually"* and paste the `WorkosCursorSessionToken` cookie value from cursor.com (DevTools → Application → Cookies).

Secrets are stored in VS Code SecretStorage (OS keychain), never in settings files. *"Cursor Usage: Clear Stored Credentials"* removes them.

## Install

**From the marketplace (recommended):** open the Extensions view in Cursor (`Ctrl+Shift+X` / `Cmd+Shift+X`), search for **"Cursor Usage Dashboard"**, and click Install. Then run **Cursor Usage: Open Dashboard** from the command palette.

**From a `.vsix` file (manual/offline install):**

```bash
npm install
npm run package        # produces cursor-usage-dashboard-x.y.z.vsix
```

In Cursor: open the command palette → **Extensions: Install from VSIX…** → pick the `.vsix`. Then run **Cursor Usage: Open Dashboard**.

## Commands

| Command | Description |
| --- | --- |
| `Cursor Usage: Open Dashboard` | Open the dashboard panel |
| `Cursor Usage: Refresh` | Reload usage data (dashboard + status bar) |
| `Cursor Usage: Set Session Token Manually` | Fallback auth via pasted cookie |
| `Cursor Usage: Set Team Admin API Key` | Team usage via the Admin API |
| `Cursor Usage: Clear Stored Credentials` | Delete stored secrets |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorUsage.statusBar.enabled` | `true` | Show token cost in the status bar |
| `cursorUsage.refreshIntervalMinutes` | `15` | Status bar refresh cadence |
| `cursorUsage.statusBar.periodDays` | `30` | Days covered by the status bar figure |
| `cursorUsage.statusBar.warnAtPercent` | `80` | % of plan quota used before the status bar turns warning-colored |
| `cursorUsage.statusBar.criticalAtPercent` | `95` | % of plan quota used before the status bar turns error-colored |

## Development

```bash
npm install
npm run compile   # type-check + bundle (dist/ + media/)
npm test          # unit tests for pricing/normalization/auth logic
npm run watch     # rebuild on change
```

Layout: `src/extension.ts` (activation), `src/auth.ts` + `src/authCore.ts` (session resolution), `src/api.ts` (cursor.com client), `src/service.ts` (shared data layer), `src/panel.ts` + `src/html.ts` (webview + RPC bridge), `src/statusBar.ts`, `src/webview/` (dashboard UI: `main.js`, `logic.js`, `styles.css`).

## Publishing (maintainers)

Cursor's built-in Extensions view searches the [Open VSX Registry](https://open-vsx.org), not the Microsoft Marketplace, so that's the one to publish to:

```bash
npx ovsx create-namespace iair -p <open-vsx-token>   # once, if the namespace isn't claimed yet
npm run package                                       # builds the .vsix
npx ovsx publish cursor-usage-dashboard-x.y.z.vsix -p <open-vsx-token>
```

Get a token from an Open VSX account (sign in with GitHub) under *Settings → Access Tokens*. Bump `version` in `package.json` before each publish.

## Caveats

- The personal-usage endpoints (`cursor.com/api/dashboard/*`) are **unofficial** — Cursor can change them at any time. Each data source degrades gracefully, and the Admin API path uses the documented official API.
- Cache savings are **estimates**: cache-read tokens × (input rate − cache-read rate) using published pricing per model. Simulator numbers are directional (same tokens, different rates), not quotes.
- All data stays on your machine; the only network calls are to cursor.com.
