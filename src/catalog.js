const catalog = {
  claude: {
    models: [
      { id: '', label: 'CLI default' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' }
    ],
    efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max']
  },
  codex: {
    models: [
      { id: '', label: 'CLI default' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' }
    ],
    efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max']
  },
  gemini: {
    models: [
      { id: '', label: 'CLI default' },
      { id: 'auto', label: 'Auto' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }
    ],
    efforts: ['']
  }
};
const modes = [
  { id: 'default', label: 'Provider default', detail: 'Use the CLI’s saved permission rules. Requests needing a prompt may be denied in this headless view.' },
  { id: 'read', label: 'Read only', detail: 'Inspect and plan without editing workspace files.' },
  { id: 'auto', label: 'Auto edits', detail: 'Allow file edits; other actions follow provider restrictions.' },
  { id: 'full', label: 'Full access · YOLO', detail: 'Allow all provider tools without approval. Commands can modify files outside this workspace.' }
];
function defaultSettings(provider) { return { model: '', effort: '', mode: 'auto' }; }
function validate(provider, settings) {
  const config = catalog[provider];
  if (!config) throw new Error('Unknown provider.');
  const model = String(settings?.model || '');
  const effort = String(settings?.effort || '');
  const mode = String(settings?.mode || 'auto');
  if (!config.models.some(m => m.id === model)) throw new Error('Choose a listed model.');
  if (!config.efforts.includes(effort)) throw new Error('Effort is unavailable for this provider.');
  if (!modes.some(m => m.id === mode)) throw new Error('Unknown access mode.');
  return { model, effort, mode };
}
module.exports = { catalog, modes, defaultSettings, validate };
