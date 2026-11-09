const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Limits, claude, codex, copilot, span } = require('../electron/limits');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

test('limits: Claude windows come from the OAuth usage endpoint; the token is never refreshed', async () => {
  const asked = [];
  const fetch = async (url, options) => {
    asked.push({ url, auth: options.headers.Authorization });
    return new Response(JSON.stringify({ five_hour: { utilization: 54.4, resets_at: '2026-10-29T20:40:00Z' }, seven_day: { utilization: 81, resets_at: '2026-11-01T02:00:00Z' }, seven_day_opus: null, extra_usage: { is_enabled: false } }));
  };
  const reading = await claude({ token: async () => ({ accessToken: 'tok', expiresAt: Date.now() + 60000, subscriptionType: 'pro' }), fetch });
  assert.deepEqual(asked, [{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'Bearer tok' }]);
  assert.equal(reading.plan, 'Claude Pro');
  assert.deepEqual(reading.windows.map(w => [w.id, w.label, w.used]), [['five_hour', 'Session (5 hours)', 54], ['seven_day', 'Week', 81]]);
  assert.equal(reading.windows[1].resetsAt, Date.parse('2026-11-01T02:00:00Z'));
  await assert.rejects(claude({ token: async () => ({ accessToken: 'old', expiresAt: Date.now() - 1 }), fetch }), /expired/);
  await assert.rejects(claude({ token: async () => ({ accessToken: 'tok' }), fetch: async () => new Response('', { status: 401 }) }), /expired/);
  await assert.rejects(claude({ token: async () => null, fetch }), /Sign in/);
});

test('limits: Codex windows come from the newest session log; a window that already reset reads 0', () => {
  const home = tmp('orin-codex-');
  const day = path.join(home, 'sessions/2026/10/29');
  fs.mkdirSync(day, { recursive: true });
  const event = (primary, secondary) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: { primary, secondary, plan_type: 'plus', credits: { has_credits: true, unlimited: false, balance: '12.5' } } } });
  const now = Date.parse('2026-10-29T18:00:00Z') ;
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [event({ used_percent: 90, window_minutes: 300, resets_at: now / 1000 - 60 }, { used_percent: 40, window_minutes: 10080, resets_at: now / 1000 + 3600 }), '{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}'].join('\n'));
  const reading = codex({ home, now });
  assert.equal(reading.plan, 'ChatGPT Plus');
  assert.equal(reading.note, 'Credits: 12');
  assert.deepEqual(reading.windows, [{ id: 'primary', label: 'Session (5 hours)', used: 0, resetsAt: null }, { id: 'secondary', label: 'Week', used: 40, resetsAt: now + 3600000 }]);
  assert.throws(() => codex({ home: tmp('orin-empty-') }), /first Codex reply/);
  assert.equal(span(1440 * 30), '30 days');
});

test('limits: Copilot quotas come from gh; unused quotas (entitlement 0) are left out', async () => {
  const bin = tmp('orin-gh-');
  const gh = path.join(bin, 'gh');
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-gh.cjs'), gh);
  fs.chmodSync(gh, 0o755);
  process.env.FAKE_GH_LOG = path.join(bin, 'log'); process.env.FAKE_GH_STATE = path.join(bin, 'state');
  const reading = await copilot({ gh });
  assert.equal(reading.plan, 'Copilot Free');
  assert.deepEqual(reading.windows, [{ id: 'chat', label: 'Chat (month)', used: 85, left: 30, total: 200, resetsAt: Date.parse('2026-11-01T00:00:00.000Z') }]);
  await assert.rejects(copilot({ gh: null }), /GitHub CLI/);
});

test('limits: one shared refresh, a fresh cache, and the last good numbers kept on an error', async () => {
  let calls = 0, fail = false;
  const changes = [];
  const limits = new Limits({ cliPath: () => '/bin/gh', onChange: (cli, r) => changes.push([cli, r.error || r.windows[0].used]),
    sources: { claude: async ({ gh }) => { calls++; assert.equal(gh, '/bin/gh'); await new Promise(r => setTimeout(r, 10)); if (fail) throw new Error('offline'); return { plan: 'P', windows: [{ id: 'w', used: 10 * calls }] }; } } });
  assert.equal(limits.supports('gemini'), false);
  assert.equal(await limits.get('gemini'), null);
  const [a, b] = await Promise.all([limits.get('claude'), limits.get('claude')]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal((await limits.get('claude')).windows[0].used, 10); // cached
  fail = true;
  const stale = await limits.get('claude', { force: true });
  assert.deepEqual([stale.error, stale.windows[0].used, stale.plan], ['offline', 10, 'P']);
  assert.deepEqual(changes, [['claude', 10], ['claude', 'offline']]);
});
