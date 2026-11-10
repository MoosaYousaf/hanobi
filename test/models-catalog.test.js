const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelCatalog, tierFromCost, claudeModels, shorten } = require('../electron/models-catalog');
const { validateSettings } = require('../electron/providers/catalog');

const day = 24 * 60 * 60 * 1000, now = Date.parse('2026-11-09T12:00:00Z');
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const raw = { anthropic: { models: {
  'claude-fable-5-2': { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', release_date: iso(now), cost: { input: 8, output: 40 }, limit: { context: 1000000 } },
  'claude-haiku-5-5': { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', release_date: iso(now - 33 * day), cost: { input: 0.1, output: 0.5 } },
  'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', release_date: iso(now - 42 * day), cost: { input: 2, output: 10 } },
  'claude-3-haiku-20240307': { id: 'claude-3-haiku-20240307', name: 'Claude Haiku 3', release_date: '2024-03-07', cost: { output: 1.25 } },
  'claude-old-4': { id: 'claude-old-4', name: 'Claude Old 4', release_date: iso(now - 400 * day) }
} }, openai: { models: { 'gpt-6-astra': { id: 'gpt-6-astra', name: 'GPT-6 Astra', release_date: '2026-09-04', cost: { output: 50 } } } }, unused: { models: {} } };

test('catalog: short form, strength from price, and the Claude Code menu of the last year without snapshots', () => {
  const providers = shorten(raw);
  assert.deepEqual(Object.keys(providers), ['anthropic', 'openai']);
  assert.deepEqual(providers.openai[0], { id: 'gpt-6-astra', name: 'GPT-6 Astra', release: '2026-09-04', input: null, output: 50, context: null });
  assert.deepEqual(['top', 'mid', 'fast', null], [{ output: 40 }, { output: 10 }, { output: 0.5 }, {}].map(tierFromCost));
  assert.deepEqual(claudeModels(providers, now), [{ id: 'claude-fable-5-2', label: 'Fable 5.2', isNew: true }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }]);
});

test('catalog: downloads once a day, keeps the last good copy on a failure, and finds OpenRouter ids', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orin-catalog-')), 'models-catalog.json');
  let calls = 0, ok = true;
  const fetch = async () => { calls++; return ok ? { ok: true, json: async () => raw } : { ok: false, status: 503 }; };
  const catalog = new ModelCatalog({ file, fetch });
  await catalog.refresh();
  await catalog.refresh();
  assert.equal(calls, 1);
  assert.equal(catalog.tier('anthropic/claude-fable-5-2'), 'top');
  assert.equal(catalog.tier('unknown-model'), null);
  ok = false;
  await assert.rejects(catalog.refresh({ force: true }), /HTTP 503/);
  assert.equal(new ModelCatalog({ file, fetch }).find('gpt-6-astra').output, 50);
});

test('catalog: a CLI model from a newer menu is valid, and a built-in model stays valid when the menu drops it', () => {
  const connection = { preset: 'claude-code' };
  assert.equal(validateSettings(connection, { model: 'claude-fable-5-2', mode: 'auto' }, [{ id: 'claude-fable-5-2' }]).model, 'claude-fable-5-2');
  assert.equal(validateSettings(connection, { model: 'claude-opus-5-5', mode: 'auto' }, [{ id: 'claude-fable-5-2' }]).model, 'claude-opus-5-5');
  assert.throws(() => validateSettings(connection, { model: 'claude-fable-5-2', mode: 'auto' }), /Choose a model/);
});
