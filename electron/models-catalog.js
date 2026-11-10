// The model catalog: what models exist, when they came out, and what they cost. It comes from models.dev, a free
// public catalog (no key), once a day, and is kept in <userData>/models-catalog.json in a short form.
// Claude Code's model menu comes from it (the CLI has no model list); prices give the Overseer each model's strength.
const fs = require('node:fs');

const URL = 'https://models.dev/api.json';
const DAY = 24 * 60 * 60 * 1000;
const NEW_DAYS = 14;
const PROVIDERS = ['anthropic', 'openai', 'google', 'deepseek', 'mistral', 'xai', 'groq'];

// Only the fields Orin uses; the full catalog is about 6 MB.
function shorten(data) {
  const providers = {};
  for (const id of PROVIDERS) {
    const models = data?.[id]?.models;
    if (!models) continue;
    providers[id] = Object.values(models).map(m => ({ id: m.id, name: m.name || m.id, release: m.release_date || '', input: m.cost?.input ?? null, output: m.cost?.output ?? null, context: m.limit?.context ?? null }));
  }
  return providers;
}

// Strength from the output price per million tokens: frontier models cost the most. Null when the price is unknown.
function tierFromCost(model) {
  if (model?.output == null) return null;
  return model.output >= 15 ? 'top' : model.output >= 2 ? 'mid' : 'fast';
}
const isNew = (release, now = Date.now()) => !!release && now - Date.parse(release) < NEW_DAYS * DAY;

// Claude Code accepts any Anthropic model id. The menu lists the newest model of each family (Opus, Sonnet, Haiku,
// Fable…) and every model of the last 90 days, newest first, without dated snapshots (claude-…-20250101).
function claudeModels(providers, now = Date.now()) {
  const list = (providers?.anthropic || []).filter(m => /^claude-/.test(m.id) && !/-\d{8}$/.test(m.id) && !/latest/.test(m.id) && m.release && now - Date.parse(m.release) < 365 * DAY)
    .sort((a, b) => b.release.localeCompare(a.release) || a.id.localeCompare(b.id));
  const families = new Set();
  return list.filter(m => {
    const family = m.id.split('-')[1];
    const keep = !families.has(family) || now - Date.parse(m.release) < 90 * DAY;
    families.add(family);
    return keep;
  }).map(m => ({ id: m.id, label: m.name.replace(/^Claude /, '').replace(/ \(latest\)$/, ''), ...(isNew(m.release, now) ? { isNew: true } : {}) }));
}

class ModelCatalog {
  constructor({ file, fetch = globalThis.fetch }) {
    Object.assign(this, { file, fetch });
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = { at: 0, providers: {} }; }
  }
  fresh() { return Date.now() - (this.data.at || 0) < DAY; }
  // Keeps the last good catalog when the download fails.
  async refresh({ force = false } = {}) {
    if (!force && this.fresh()) return this.data;
    const response = await this.fetch(URL, { headers: { 'User-Agent': 'Orin' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`The model catalog is unavailable (HTTP ${response.status}).`);
    this.data = { at: Date.now(), providers: shorten(await response.json()) };
    fs.writeFileSync(this.file, JSON.stringify(this.data));
    return this.data;
  }
  // The catalog entry of a model id, from any provider. Ids from OpenRouter ("anthropic/claude-…") also match.
  find(id) {
    const bare = String(id || '').split('/').pop();
    for (const list of Object.values(this.data.providers || {})) { const hit = list.find(m => m.id === bare); if (hit) return hit; }
    return null;
  }
  tier(id) { return tierFromCost(this.find(id)); }
  price(id) { return this.find(id)?.output ?? null; }
  isNew(id) { return isNew(this.find(id)?.release); }
  claudeModels() { return claudeModels(this.data.providers); }
}

module.exports = { ModelCatalog, shorten, tierFromCost, claudeModels, isNew };
