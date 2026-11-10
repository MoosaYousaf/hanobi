// Overseer: picks the connection, model, and effort for each turn of a conversation that has it on.
// Fixed rules decide when the task stays the same; a small router model (Haiku through Claude Code) decides on a new
// task, and the rules take over when the router is off, slow, or wrong. Plan limits keep work off a nearly used plan.
// Staying on the same connection matters: a different provider gets the whole transcript again and loses the CLI cache.

const ROUTE_ORDER = { subscription: 0, local: 1, key: 2 };
const TIER_RANK = { fast: 0, mid: 1, top: 2 };
const EFFORT_FOR = { quick: 'low', normal: 'medium', hard: 'high' };
const TIER_FOR = { quick: 'fast', normal: 'mid', hard: 'top' };
const ROUTER = { connectionId: 'claude-code', model: 'claude-haiku-5-5' };
const ROUTER_MS = 10000;

// Strength of the built-in CLI models when the model catalog is not loaded yet (from their prices on 2026-11-09).
const TIERS = {
  'claude-opus-5-5': 'top', 'claude-fable-5-1': 'top', 'claude-sonnet-5-5': 'mid', 'claude-haiku-5-5': 'fast',
  'gpt-6-astra': 'top', 'gpt-6.1-sol': 'mid', 'gpt-6.1-terra': 'mid', 'gpt-6-luna': 'fast'
};
// Other model ids get a tier from words in the id. Local models are always "fast": they run on this Mac.
function tierOf(model, route) {
  if (route === 'local') return 'fast';
  if (TIERS[model]) return TIERS[model];
  const id = model.toLowerCase();
  // Words count only at the start of an id part, so "gemini" is not "mini".
  if (/(^|[-_.:/])(mini|nano|flash|haiku|lite|small|tiny|\d{1,2}b)($|[-_.:/])/.test(id)) return 'fast';
  if (/(^|[-_.:/])(opus|ultra|max|large|pro|reasoner|o\d)($|[-_.:/])/.test(id)) return 'top';
  return 'mid';
}

const HARD = /\b(architect\w*|design|debug\w*|root cause|why (does|is|did)|refactor\w*|race condition|deadlock|security|vulnerab\w*|prove|algorithm|optimi[sz]\w*|performance|migrat\w*|plan)\b/i;
// quick: short chat questions; hard: design, debugging, long or many-file requests; normal: everything else.
function classify(text, { workspaceKind = 'code', files = 0 } = {}) {
  const t = String(text || '');
  if (HARD.test(t) || t.length > 1500 || files >= 3) return 'hard';
  const chat = workspaceKind !== 'code';
  if (t.length < 160 && !t.includes('\n') && !t.includes('```') && (chat || (t.length < 60 && t.trim().endsWith('?')))) return 'quick';
  return 'normal';
}

// Highest use of the plan windows that apply to a model. Claude also has weekly windows per model family.
function planUse(reading, model = '') {
  if (!reading?.windows?.length) return 0;
  const family = /opus/.test(model) ? 'opus' : /sonnet/.test(model) ? 'sonnet' : '';
  return Math.max(0, ...reading.windows.filter(w => !/_(opus|sonnet)$/.test(w.id) || w.id.endsWith(`_${family}`)).map(w => w.used || 0));
}

// Every model the Overseer may use: ready connections, listed or loaded models, no paid keys unless allowed.
// An installed CLI may not be signed in, so a CLI counts only after it gave a reply (used) or the user included it.
// on: false marks a model that the Overseer skips; all: true keeps those in the list for the settings.
// tierOf(model id) gives a strength from the model catalog's prices; the built-in table and id words are the fallback.
function candidates({ connections, modelsOf, presets, prefs = {}, used = new Set(), all = false, tierOf: catalogTier, priceOf }) {
  const exclude = new Set(prefs.exclude || []), include = new Set(prefs.include || []);
  const out = [];
  for (const c of connections) {
    const preset = presets[c.preset];
    if (!c.ready || !preset || (c.route === 'key' && !prefs.allowPaid)) continue;
    for (const m of modelsOf(c.id) || []) {
      if (!m.id || m.id === 'auto') continue;
      const id = `${c.id}::${m.id}`;
      // A CLI may be installed but not signed in, and a local model is slow on a small Mac: both need a reply or a choice.
      const on = !exclude.has(id) && (preset.kind !== 'cli' && c.route !== 'local' || used.has(c.id) || include.has(id));
      if (on || all) out.push({ id, on, connectionId: c.id, model: m.id, label: `${m.label || m.id} · ${c.name}`, route: c.route, cli: preset.cli, efforts: preset.efforts, tier: (c.route !== 'local' && catalogTier?.(m.id)) || tierOf(m.id, c.route), price: c.route === 'local' ? 0 : priceOf?.(m.id) ?? null });
    }
  }
  return out;
}

const effortFor = (candidate, effort) => (candidate.efforts.includes(effort) ? effort : candidate.efforts.includes('medium') && effort ? 'medium' : '');

// The rules: plans under the soft limit first; then the wanted tier, or the nearest one (a stronger model before a
// weaker one); then the previous connection; then subscriptions, local, and keys; then the lower price (it uses less
// of a plan too); then the plan with the most left. An unknown price sorts after known ones.
function byRules({ kind, list, use, previous, soft = 80 }) {
  const want = TIER_RANK[TIER_FOR[kind]];
  const busy = c => (use(c) >= soft ? 1 : 0);
  const distance = c => Math.abs(TIER_RANK[c.tier] - want) * 2 + (TIER_RANK[c.tier] < want ? 1 : 0);
  const stays = c => (c.connectionId === previous?.connectionId ? 0 : 1);
  const price = c => c.price ?? Infinity;
  const cheaper = (a, b) => (price(a) === price(b) ? 0 : price(a) < price(b) ? -1 : 1);
  const sorted = list.slice().sort((a, b) => busy(a) - busy(b) || distance(a) - distance(b) || stays(a) - stays(b) || ROUTE_ORDER[a.route] - ROUTE_ORDER[b.route] || cheaper(a, b) || use(a) - use(b));
  return sorted[0] || null;
}

function routerPrompt({ text, kind, workspaceKind, list, use, previous }) {
  const rows = list.map(c => `${c.id} | ${c.label} | strength: ${c.tier}${c.price != null ? ` | $${c.price}/M output` : ''} | plan used: ${Math.round(use(c))}%`).join('\n');
  return [
    'You are the router of Orin, a desktop app with several AI models. Choose the model that answers the user\'s next message.',
    'Rules: choose the cheapest model that will do the task well. Stay on the previous model unless the task needs a different strength. Avoid plans above 80% used. Use high effort only for hard design, debugging, or reasoning; low for quick questions.',
    'Reply with JSON only, no other text: {"id": "<candidate id>", "effort": "low|medium|high", "reason": "<at most 8 words>"}',
    '', 'Candidates (id | name | strength | price | plan used):', rows,
    '', `Workspace: ${workspaceKind}. A simple classifier says: ${kind}.`,
    `Previous model: ${previous ? `${previous.connectionId}::${previous.model}, effort ${previous.effort || 'default'}` : 'none (first message)'}.`,
    '', 'User message:', '<<<', String(text || '').slice(0, 3000), '>>>'
  ].join('\n');
}

function parseRouter(reply, list) {
  const match = String(reply || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    const pick = list.find(c => c.id === value.id);
    return pick ? { pick, effort: String(value.effort || ''), reason: String(value.reason || '').slice(0, 80) } : null;
  } catch { return null; }
}

// Returns { connectionId, model, effort, reason, by: 'same' | 'router' | 'rules', kind }, or null when nothing can run.
// readLimits(cli) gives a plan reading or null; complete(prompt, signal) runs the router model once.
async function decide({ text, workspaceKind, files = 0, previous, list, readLimits, complete, prefs = {}, signal }) {
  const soft = prefs.softLimit ?? 80, hard = prefs.hardLimit ?? 90;
  const readings = new Map();
  await Promise.all([...new Set(list.map(c => c.cli).filter(Boolean))].map(async cli => {
    readings.set(cli, await Promise.race([readLimits(cli).catch(() => null), new Promise(r => setTimeout(r, 3000, null))]));
  }));
  const use = c => (c.cli ? planUse(readings.get(c.cli), c.model) : 0);
  const open = list.filter(c => use(c) < hard);
  if (!open.length) return null;
  const kind = classify(text, { workspaceKind, files });
  const route = (pick, effort, reason, by) => ({ connectionId: pick.connectionId, model: pick.model, effort: effortFor(pick, effort), reason, by, kind });

  // The same kind of task on a model that is still open and under the soft limit stays where it is: no router call.
  const same = previous && open.find(c => c.connectionId === previous.connectionId && c.model === previous.model);
  if (same && previous.kind === kind && use(same) < soft) return route(same, previous.effort ?? '', 'Same task, same model', 'same');

  if (prefs.router !== 'rules' && complete) {
    try {
      const reply = await complete(routerPrompt({ text, kind, workspaceKind, list: open, use, previous }), AbortSignal.any([signal, AbortSignal.timeout(ROUTER_MS)].filter(Boolean)));
      const picked = parseRouter(reply, open);
      if (picked) return route(picked.pick, picked.effort, picked.reason || 'Chosen by the router', 'router');
    } catch (error) { if (signal?.aborted) throw error; }
  }
  const pick = byRules({ kind, list: open, use, previous, soft });
  const label = { quick: 'Quick question', normal: 'Regular task', hard: 'Hard task' }[kind];
  return route(pick, EFFORT_FOR[kind], `${label}${use(pick) >= soft ? ', other plans are busier' : ''}`, 'rules');
}

module.exports = { decide, classify, candidates, tierOf, planUse, byRules, parseRouter, routerPrompt, ROUTER, TIERS };
