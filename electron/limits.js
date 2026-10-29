const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { tail, lastMatch } = require('./providers/usage');

// Plan limits of the CLI subscriptions: how much of each usage window is used, and when it resets.
// Shape: { plan, windows: [{ id, label, used (percent), left?, total?, resetsAt (ms) }], note?, at, error? }.
// The first window is the shortest one, the "session". Every source is free: no model call, no quota.

const run = (file, args, timeout = 15000) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } },
    (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)));
});
const percent = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const span = minutes => (minutes === 300 ? 'Session (5 hours)' : minutes === 10080 ? 'Week' : minutes % 1440 === 0 ? `${minutes / 1440} days` : `${Math.round(minutes / 60)} hours`);

// Claude Code keeps its sign-in in the Keychain item "Claude Code-credentials". Hanobi only reads the access token and
// never refreshes it: a refresh would replace the CLI's refresh token. The token stays in main.
async function claudeToken() {
  const raw = await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']).catch(() => '');
  try { return JSON.parse(raw).claudeAiOauth || null; } catch { return null; }
}
const CLAUDE_WINDOWS = [['five_hour', 'Session (5 hours)'], ['seven_day', 'Week'], ['seven_day_opus', 'Week, Opus'], ['seven_day_sonnet', 'Week, Sonnet']];
async function claude({ token = claudeToken, fetch = globalThis.fetch } = {}) {
  const auth = await token();
  if (!auth?.accessToken) throw new Error('Sign in to Claude Code to see plan usage.');
  if (auth.expiresAt && auth.expiresAt < Date.now()) throw new Error('The Claude Code sign-in expired. Send a message with Claude Code to renew it.');
  const response = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15000) });
  if (response.status === 401) throw new Error('The Claude Code sign-in expired. Send a message with Claude Code to renew it.');
  if (!response.ok) throw new Error(`Claude usage is unavailable (HTTP ${response.status}).`);
  const data = await response.json();
  const windows = CLAUDE_WINDOWS.filter(([key]) => data[key]).map(([id, label]) => ({ id, label, used: percent(data[id].utilization), resetsAt: Date.parse(data[id].resets_at) || null }));
  const extra = data.extra_usage?.is_enabled && data.extra_usage.utilization != null ? `Extra usage: ${percent(data.extra_usage.utilization)}% of the monthly limit` : '';
  return { plan: auth.subscriptionType ? `Claude ${auth.subscriptionType[0].toUpperCase()}${auth.subscriptionType.slice(1)}` : 'Claude', windows, note: extra };
}

// Codex writes rate_limits with every token_count event of its session logs. The newest log has the newest numbers.
function codex({ home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), now = Date.now() } = {}) {
  const root = path.join(home, 'sessions');
  const newest = dir => { try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; } };
  const logs = [];
  scan: for (const y of newest(root)) for (const m of newest(path.join(root, y))) for (const d of newest(path.join(root, y, m))) {
    for (const f of newest(path.join(root, y, m, d))) if (f.endsWith('.jsonl')) logs.push(path.join(root, y, m, d, f));
    if (logs.length >= 20) break scan;
  }
  logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of logs.slice(0, 20)) {
    const limits = lastMatch(tail(file), e => e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload.rate_limits?.primary && e.payload.rate_limits);
    if (!limits) continue;
    // A window that reset after the log was written starts again at 0.
    const windows = ['primary', 'secondary'].filter(k => limits[k]).map(k => {
      const w = limits[k], resetsAt = w.resets_at ? w.resets_at * 1000 : null;
      return { id: k, label: span(w.window_minutes), used: resetsAt && resetsAt < now ? 0 : percent(w.used_percent), resetsAt: resetsAt && resetsAt < now ? null : resetsAt };
    });
    const credits = limits.credits?.has_credits && !limits.credits.unlimited && Number(limits.credits.balance) ? `Credits: ${Math.floor(Number(limits.credits.balance))}` : '';
    return { plan: limits.plan_type ? `ChatGPT ${limits.plan_type[0].toUpperCase()}${limits.plan_type.slice(1)}` : 'Codex', windows, note: credits };
  }
  throw new Error('Codex usage shows after the first Codex reply.');
}

// GitHub's Copilot account endpoint, through the gh sign-in. Quotas are monthly.
const COPILOT_QUOTAS = [['premium_interactions', 'Premium requests (month)'], ['chat', 'Chat (month)']];
const SKUS = { free_limited_copilot: 'Copilot Free', copilot_pro: 'Copilot Pro', copilot_pro_plus: 'Copilot Pro+' };
async function copilot({ gh }) {
  if (!gh) throw new Error('Install the GitHub CLI (gh) and run "gh auth login" to see Copilot usage.');
  const data = JSON.parse(await run(gh, ['api', '/copilot_internal/user']));
  const resetsAt = Date.parse(data.quota_reset_date_utc || data.quota_reset_date) || null;
  const windows = COPILOT_QUOTAS.map(([id, label]) => [id, label, data.quota_snapshots?.[id]]).filter(([, , q]) => q && !q.unlimited && q.entitlement > 0)
    .map(([id, label, q]) => ({ id, label, used: percent(100 - q.percent_remaining), left: Math.max(0, Math.floor(q.remaining)), total: q.entitlement, resetsAt }));
  const unlimited = COPILOT_QUOTAS.filter(([id]) => data.quota_snapshots?.[id]?.unlimited).map(([, label]) => label.replace(' (month)', ''));
  return { plan: SKUS[data.access_type_sku] || 'GitHub Copilot', windows, note: unlimited.length ? `Unlimited: ${unlimited.join(', ')}` : '' };
}

const SOURCES = { claude, codex, copilot };
const FRESH_MS = 60 * 1000;

// One cached reading per CLI. get() returns the cache when it is fresh; a refresh that is already running is shared.
class Limits {
  constructor({ cliPath, sources = SOURCES, onChange = () => {} }) {
    Object.assign(this, { cliPath, sources, onChange });
    this.cache = new Map(); // cli -> reading
    this.loading = new Map(); // cli -> promise
  }
  supports(cli) { return !!this.sources[cli]; }
  async get(cli, { force = false } = {}) {
    if (!this.supports(cli)) return null;
    const cached = this.cache.get(cli);
    if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached;
    if (!this.loading.has(cli)) {
      const job = (async () => {
        let reading;
        try { reading = { ...await this.sources[cli]({ gh: this.cliPath('gh') }), at: Date.now() }; }
        catch (error) { reading = { ...(cached && !cached.error ? cached : { windows: [] }), error: error.message || String(error), at: Date.now() }; }
        this.cache.set(cli, reading);
        this.onChange(cli, reading);
        return reading;
      })().finally(() => this.loading.delete(cli));
      this.loading.set(cli, job);
    }
    return this.loading.get(cli);
  }
}

module.exports = { Limits, claude, codex, copilot, span };
