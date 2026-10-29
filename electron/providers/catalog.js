// Every way Hanobi can reach a model. A "connection" is one configured instance of a preset.
// route: subscription = an installed CLI with its own sign-in; key = API key; local = a model server on this Mac.
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const presets = {
  'claude-code': { kind: 'cli', cli: 'claude', name: 'Claude Code', route: 'subscription', efforts: EFFORTS,
    models: [{ id: '', label: 'CLI default' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }, { id: 'claude-fable-5-1', label: 'Fable 5.1' }] },
  codex: { kind: 'cli', cli: 'codex', name: 'Codex', route: 'subscription', efforts: EFFORTS,
    models: [{ id: '', label: 'CLI default' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { id: 'gpt-6-astra', label: 'GPT-6 Astra' }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }] },
  gemini: { kind: 'cli', cli: 'gemini', name: 'Gemini CLI', route: 'subscription', efforts: [''], note: 'Works with a Gemini API key or a Workspace account. Personal Google AI plans moved to Antigravity; use the Google Gemini API connection instead.',
    models: [{ id: '', label: 'CLI default' }, { id: 'auto', label: 'Auto' }, { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' }, { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' }] },
  copilot: { kind: 'cli', cli: 'copilot', name: 'GitHub Copilot', route: 'subscription', efforts: EFFORTS, customModels: true,
    note: 'Uses your GitHub sign-in and Copilot plan. Models depend on the plan; type any model id your plan offers.',
    models: [{ id: '', label: 'CLI default' }, { id: 'auto', label: 'Auto' }] },
  anthropic: { kind: 'anthropic', name: 'Anthropic API', route: 'key', needsKey: true, efforts: EFFORTS, defaultModel: 'claude-opus-5-5', keyUrl: 'https://platform.claude.com/settings/keys' },
  openai: { kind: 'openai', name: 'OpenAI', route: 'key', needsKey: true, baseURL: 'https://api.openai.com/v1', efforts: ['', 'low', 'medium', 'high'], keyUrl: 'https://platform.openai.com/api-keys' },
  google: { kind: 'openai', name: 'Google Gemini API', route: 'key', needsKey: true, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', efforts: ['', 'low', 'medium', 'high'], keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { kind: 'openai', name: 'OpenRouter', route: 'key', needsKey: true, baseURL: 'https://openrouter.ai/api/v1', efforts: ['', 'low', 'medium', 'high'], keyUrl: 'https://openrouter.ai/keys' },
  deepseek: { kind: 'openai', name: 'DeepSeek', route: 'key', needsKey: true, baseURL: 'https://api.deepseek.com', efforts: [''], keyUrl: 'https://platform.deepseek.com/api_keys' },
  mistral: { kind: 'openai', name: 'Mistral', route: 'key', needsKey: true, baseURL: 'https://api.mistral.ai/v1', efforts: [''], keyUrl: 'https://console.mistral.ai/api-keys' },
  groq: { kind: 'openai', name: 'Groq', route: 'key', needsKey: true, baseURL: 'https://api.groq.com/openai/v1', efforts: ['', 'low', 'medium', 'high'], keyUrl: 'https://console.groq.com/keys' },
  xai: { kind: 'openai', name: 'xAI Grok', route: 'key', needsKey: true, baseURL: 'https://api.x.ai/v1', efforts: ['', 'low', 'high'], keyUrl: 'https://console.x.ai' },
  'github-models': { kind: 'openai', name: 'GitHub Models', route: 'key', needsKey: true, baseURL: 'https://models.github.ai/inference', modelsURL: 'https://models.github.ai/catalog/models', efforts: [''], keyUrl: 'https://github.com/settings/personal-access-tokens' },
  ollama: { kind: 'openai', name: 'Ollama', route: 'local', needsKey: false, baseURL: 'http://localhost:11434/v1', efforts: [''] },
  lmstudio: { kind: 'openai', name: 'LM Studio', route: 'local', needsKey: false, baseURL: 'http://localhost:1234/v1', efforts: [''] },
  custom: { kind: 'openai', name: 'OpenAI-compatible', route: 'key', needsKey: false, baseURL: '', efforts: ['', 'low', 'medium', 'high'] }
};

// CLI agents control their own tools; API chats ask before each MCP tool call unless set to allow.
const modes = {
  cli: [
    { id: 'default', label: 'CLI rules', detail: 'Use the CLI’s saved permission rules. Requests that need a prompt are denied in this view.' },
    { id: 'read', label: 'Read only', detail: 'Inspect and plan without editing files.' },
    { id: 'auto', label: 'Auto edits', detail: 'Allow file edits. Other actions follow the CLI’s restrictions.' },
    { id: 'full', label: 'Full access', detail: 'Run every tool without approval, including outside this folder.', danger: true }
  ],
  api: [
    { id: 'ask', label: 'Ask first', detail: 'Ask before each tool call.' },
    { id: 'full', label: 'Allow tools', detail: 'Run connected tools without asking.', danger: true }
  ]
};
const modeGroup = kind => (kind === 'cli' ? 'cli' : 'api');

function validateSettings(connection, settings) {
  const preset = presets[connection.preset];
  if (!preset) throw new Error('Unknown connection.');
  const model = String(settings.model ?? '');
  const effort = String(settings.effort ?? '');
  const mode = String(settings.mode ?? modes[modeGroup(preset.kind)][0].id);
  const listed = preset.kind === 'cli' && preset.models.some(m => m.id === model);
  if (!listed && (preset.kind === 'cli' && !preset.customModels || !/^[\w.:/@+-]{1,200}$/.test(model))) throw new Error('Choose a model.');
  if (!preset.efforts.includes(effort)) throw new Error('This model does not support that effort level.');
  if (!modes[modeGroup(preset.kind)].some(m => m.id === mode)) throw new Error('Unknown access mode.');
  return { model, effort, mode };
}

module.exports = { presets, modes, modeGroup, validateSettings };
