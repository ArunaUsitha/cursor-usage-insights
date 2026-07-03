// Unit tests for the pure logic shared by the webview and extension host.
// Run: npm test

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

import {
  parsePricing,
  matchPricing,
  estimateTokenCost,
  cacheSavingsFor,
  displayModel,
  normalize,
  summarize,
  detectBillingMode,
  percentile,
} from '../src/webview/logic.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Bundle the TS modules under test into importable ESM.
async function loadTs(entry, outName) {
  const outfile = path.join(here, '.build', outName);
  await build({
    entryPoints: [path.join(here, '..', entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  return import(outfile);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

const md = readFileSync(path.join(here, 'fixtures', 'pricing.md'), 'utf8');
const pricing = parsePricing(md);

console.log('parsePricing');
test('parses Auto rates', () => {
  assert.equal(pricing.auto.input, 1.25);
  assert.equal(pricing.auto.cacheWrite, 1.25);
  assert.equal(pricing.auto.cacheRead, 0.25);
  assert.equal(pricing.auto.output, 6.0);
});
test('parses model table incl. links and missing cells', () => {
  assert.equal(pricing.models.length, 4);
  const sonnet = pricing.models.find((m) => m.display === 'Claude 4.5 Sonnet');
  assert.deepEqual(
    [sonnet.input, sonnet.cacheWrite, sonnet.cacheRead, sonnet.output],
    [3.0, 3.75, 0.3, 15.0],
  );
  const gpt = pricing.models.find((m) => m.display === 'GPT-5.2');
  assert.equal(gpt.cacheWrite, null);
});

console.log('matchPricing');
test('auto and default map to Auto rates', () => {
  assert.equal(matchPricing('auto', pricing).label, 'Auto');
  assert.equal(matchPricing('default', pricing).input, 1.25);
});
test('alias and partial matching', () => {
  assert.equal(matchPricing('claude-4.5-sonnet', pricing).label, 'Claude 4.5 Sonnet');
  assert.equal(matchPricing('claude-4-5-sonnet-thinking', pricing).label, 'Claude 4.5 Sonnet');
});
test('unknown model returns null', () => {
  assert.equal(matchPricing('mystery-model-9000', pricing), null);
});

console.log('cost math');
test('estimateTokenCost combines all rates', () => {
  const rates = matchPricing('claude-4.5-sonnet', pricing);
  const cost = estimateTokenCost(rates, { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 });
  assert.ok(Math.abs(cost - (3.0 + 1.5 + 0.6)) < 1e-9);
});
test('cacheSavingsFor uses input minus cache-read rate', () => {
  const rates = matchPricing('claude-4.5-sonnet', pricing);
  const savings = cacheSavingsFor({ cacheRead: 1_000_000 }, rates);
  assert.ok(Math.abs(savings - 2.7) < 1e-9);
});

console.log('normalize');
const tokenBasedRaw = {
  id: 'a',
  timestamp: '1750000000000',
  model: 'claude-4.5-sonnet',
  isTokenBasedCall: true,
  chargedCents: 123,
  cursorTokenFee: 3,
  tokenUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50000, cacheWriteTokens: 0, totalCents: 100 },
};
const usageBasedRaw = {
  id: 'b',
  timestamp: 1750000, // seconds — should be scaled to ms
  model: 'auto',
  isTokenBasedCall: false,
  chargedCents: 4,
  tokenUsage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalCents: 2 },
};
test('token-based event uses chargedCents as primary cost', () => {
  const e = normalize(tokenBasedRaw, pricing);
  assert.equal(e.cost, 1.23);
  assert.equal(e.tokenCost, 1.03);
  assert.equal(e.requestCharge, null);
  assert.equal(e.totalTokens, 51200);
  assert.equal(e.timestampMs, 1750000000000);
});
test('usage-based event separates flat fee from token cost', () => {
  const e = normalize(usageBasedRaw, pricing);
  assert.equal(e.cost, 0.02);
  assert.equal(e.requestCharge, 0.04);
  assert.equal(e.model, 'Auto');
  assert.equal(e.timestampMs, 1750000 * 1000);
});

console.log('summaries');
test('detectBillingMode: token / usage / mixed', () => {
  const t = normalize(tokenBasedRaw, pricing);
  const u = normalize(usageBasedRaw, pricing);
  assert.equal(detectBillingMode([t]), 'token');
  assert.equal(detectBillingMode([u]), 'usage');
  assert.equal(detectBillingMode([t, u]), 'mixed');
});
test('summarize totals costs, fees, and savings', () => {
  const events = [normalize(tokenBasedRaw, pricing), normalize(usageBasedRaw, pricing)];
  const s = summarize(events);
  assert.equal(s.count, 2);
  assert.ok(Math.abs(s.totalCost - 1.25) < 1e-9);
  assert.ok(Math.abs(s.totalRequestFees - 0.04) < 1e-9);
  assert.equal(s.billingMode, 'mixed');
  assert.equal(s.hasUsageFees, true);
});
test('billedCost: included/errored kinds are 0, charges bill, free plan forces 0', () => {
  const included = normalize({ ...tokenBasedRaw, kind: 'Included in Pro' }, pricing);
  assert.equal(included.billedCost, 0);
  const errored = normalize({ ...tokenBasedRaw, kind: 'Errored, Not Charged' }, pricing);
  assert.equal(errored.billedCost, 0);
  const charged = normalize(tokenBasedRaw, pricing);
  assert.equal(charged.billedCost, 1.23);
  const usageFee = normalize(usageBasedRaw, pricing);
  assert.equal(usageFee.billedCost, 0.04);
  const free = normalize(tokenBasedRaw, pricing, { freePlan: true });
  assert.equal(free.billedCost, 0);
  assert.equal(free.valueCost, free.cost);
  const unknown = normalize({ model: 'x', tokenUsage: { totalCents: 10 } }, pricing);
  assert.equal(unknown.billedCost, null);
});
test('percentile', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.75), 4);
  assert.equal(percentile([], 0.75), null);
});
test('displayModel maps default/auto', () => {
  assert.equal(displayModel('default'), 'Auto');
  assert.equal(displayModel('gpt-5.2'), 'gpt-5.2');
});

// --- TS modules -----------------------------------------------------------

const authCore = await loadTs('src/authCore.ts', 'authCore.mjs');
const api = await loadTs('src/api.ts', 'api.mjs');

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

console.log('authCore');
test('decodeJwtPayload + userIdFromSub + buildCookieValue', () => {
  const token = fakeJwt({ sub: 'auth0|user_123', exp: 9999999999 });
  const payload = authCore.decodeJwtPayload(token);
  assert.equal(payload.sub, 'auth0|user_123');
  const userId = authCore.userIdFromSub(payload.sub);
  assert.equal(userId, 'user_123');
  assert.equal(authCore.buildCookieValue(userId, 'tok'), 'user_123%3A%3Atok');
});
test('normalizeManualToken accepts cookie value, pair, :: form, bare JWT', () => {
  assert.equal(authCore.normalizeManualToken('user_1%3A%3Aabc'), 'user_1%3A%3Aabc');
  assert.equal(authCore.normalizeManualToken('WorkosCursorSessionToken=user_1%3A%3Aabc'), 'user_1%3A%3Aabc');
  assert.equal(authCore.normalizeManualToken('user_1::abc'), 'user_1%3A%3Aabc');
  const jwt = fakeJwt({ sub: 'auth0|user_9' });
  assert.equal(authCore.normalizeManualToken(jwt), `user_9%3A%3A${jwt}`);
  assert.equal(authCore.normalizeManualToken('garbage'), null);
});

console.log('api.toRawEvent');
test('maps dashboard event shape defensively', () => {
  const raw = api.toRawEvent({
    timestamp: '1750000000000',
    model: 'claude-4.5-sonnet',
    kindLabel: 'Included in Pro',
    isTokenBasedCall: true,
    usageBasedCosts: '$1.23',
    tokenUsage: { inputTokens: '10', outputTokens: '2', cacheReadTokens: '5', cacheWriteTokens: '0', totalCents: 100 },
  });
  assert.equal(raw.model, 'claude-4.5-sonnet');
  assert.equal(raw.chargedCents, 123);
  assert.equal(raw.tokenUsage.inputTokens, 10);
  assert.equal(raw.kind, 'Included in Pro');
});
test('numeric cents pass through; "-" cost is null', () => {
  assert.equal(api.toRawEvent({ chargedCents: 55, model: 'x' }).chargedCents, 55);
  assert.equal(api.toRawEvent({ usageBasedCosts: '-', model: 'x' }).chargedCents, null);
});

console.log('service.sumBilledCostDollars');
const service = await loadTs('src/service.ts', 'service.mjs');
test('sums chargedCents, zeroing included/errored kinds', () => {
  const events = [
    api.toRawEvent({ chargedCents: 100, model: 'x' }),
    api.toRawEvent({ chargedCents: 200, kind: 'Included in Pro', model: 'x' }),
    api.toRawEvent({ chargedCents: 300, kind: 'Errored, Not Charged', model: 'x' }),
  ];
  assert.equal(service.sumBilledCostDollars(events), 1.0);
});
test('free plan forces 0 regardless of chargedCents', () => {
  const events = [api.toRawEvent({ chargedCents: 500, model: 'x' })];
  assert.equal(service.sumBilledCostDollars(events, { membershipType: 'free' }), 0);
  assert.equal(service.sumBilledCostDollars(events, { membershipType: 'pro' }), 5.0);
});

console.log('api.parseQuotaResponse');
test('prefers the gpt-4 bucket and passes through startOfMonth', () => {
  const quota = api.parseQuotaResponse({
    'gpt-4': { numRequests: 342, maxRequestUsage: 500 },
    'gpt-3.5-turbo': { numRequests: 10, maxRequestUsage: 1000 },
    startOfMonth: '2026-07-01T00:00:00.000Z',
  });
  assert.deepEqual(quota, { used: 342, limit: 500, startOfCycleIso: '2026-07-01T00:00:00.000Z' });
});
test('falls back to any bucket with a limit when gpt-4 is absent', () => {
  const quota = api.parseQuotaResponse({ 'claude-3.5-sonnet': { numRequests: 5, maxRequestUsage: 50 } });
  assert.deepEqual(quota, { used: 5, limit: 50 });
});
test('returns null for shapes with no request-quota buckets', () => {
  assert.equal(api.parseQuotaResponse({ someOtherField: 1 }), null);
  assert.equal(api.parseQuotaResponse(null), null);
  assert.equal(api.parseQuotaResponse('not an object'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
