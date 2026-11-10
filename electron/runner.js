const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { presets, modesFor, validateSettings } = require('./providers/catalog');
const { Draft } = require('./draft');
const cli = require('./providers/cli');
const anthropic = require('./providers/anthropic');
const git = require('./git');
const suggest = require('./suggest');
const commands = require('./commands');
const projects = require('./projects');
const openai = require('./providers/openai');
const { contextWindow } = require('./providers/usage');
const { attachmentBlock, mediaType } = require('./files');
const overseer = require('./overseer');
const codexServer = require('./providers/codex-server');

const UPDATE_MS = 60;
const LOCAL_ID = 'orin-local';

const SKIPPED = 'The user skipped the questions. Continue with your best judgment, or ask in plain text.';
// API and local models get this tool next to the MCP tools, so any model can ask structured questions.
const ASK_TOOL = {
  qualified: 'orin__ask_user', server: 'Orin', name: 'ask_user',
  description: 'Ask the user 1 to 4 multiple-choice questions when a decision is theirs to make and you cannot resolve it from context. The user can also type their own answer. Returns the answers, keyed by question text.',
  inputSchema: { type: 'object', required: ['questions'], properties: { questions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['question', 'options'], properties: {
    question: { type: 'string' }, header: { type: 'string', description: 'A label of at most 12 characters.' }, multiSelect: { type: 'boolean' },
    options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' } } } }
  } } } } }
};

// API and local models make files with this tool. The user gets a file card with Preview, Open, and Save.
const WRITE_TOOL = {
  qualified: 'orin__write_file', server: 'Orin', name: 'write_file',
  description: 'Create a file for the user to preview, open, and download, such as a report, a table, or a document. The extension sets the format. Text formats (.txt, .md, .csv, .json, .py, .svg, and others) take the file text. Rich formats (.docx, .pdf, .rtf, .odt, .html) take HTML body content: headings, paragraphs, lists, tables, and inline styles. Returns the saved file name.',
  inputSchema: { type: 'object', required: ['name', 'content'], properties: { name: { type: 'string', description: 'File name with extension, for example report.docx or data.csv.' }, content: { type: 'string' } } }
};

// One question shape for every source: { id, question, header, options: [{ label, description }], multiSelect }.
function normalizeQuestions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 4).map((q, i) => ({
    id: String(q?.id ?? i), question: String(q?.question || '').slice(0, 1000), header: String(q?.header || '').slice(0, 40), multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 8).map(o => ({ label: String(o?.label ?? o).slice(0, 200), description: String(o?.description || '').slice(0, 500) }))
  })).filter(q => q.question);
}
// Every question needs at least one answer; anything else counts as skipped.
function validAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object') return null;
  const out = {};
  for (const q of questions) {
    const list = (Array.isArray(answers[q.id]) ? answers[q.id] : []).map(a => String(a).trim().slice(0, 2000)).filter(Boolean);
    if (!list.length) return null;
    out[q.id] = q.multiSelect ? list : list.slice(0, 1);
  }
  return out;
}

class Runner {
  constructor({ store, secrets, mcp, send, files, limits, catalog, local }) {
    Object.assign(this, { store, secrets, mcp, send, files, limits, catalog, local });
    this.runs = new Map(); // threadId -> { controller, draft }
    this.approvals = new Map(); // approvalId -> resolve
  }

  // CLI connections exist when the CLI is installed; API connections are what the user added.
  connections() {
    const clis = Object.entries(presets).filter(([, p]) => p.kind === 'cli').map(([id, p]) => ({ id, preset: id, name: p.name, route: p.route, kind: p.kind, ready: !!cli.cliPath(p.cli), detail: cli.cliPath(p.cli) ? 'Uses your CLI sign-in' : 'Not installed' }));
    const apis = this.store.data.connections.map(c => {
      const p = presets[c.preset];
      const hasKey = this.secrets.has(`key:${c.id}`);
      return { ...c, route: p.route, kind: p.kind, hasKey, ready: !p.needsKey || hasKey, detail: p.needsKey && !hasKey ? 'API key missing' : c.baseURL || p.baseURL || 'Anthropic API' };
    });
    // Downloaded models run through the local engine; this connection is always there and ready when both exist.
    const local = this.local ? [(() => {
      const hasModels = this.local.library.list().length > 0, installed = this.local.engine.installed();
      return { id: LOCAL_ID, preset: LOCAL_ID, name: presets[LOCAL_ID].name, route: 'local', kind: 'openai', hasKey: false, ready: installed && hasModels,
        detail: !installed ? 'Install the local engine in Settings → Models' : !hasModels ? 'Download a model in Settings → Models' : 'Runs on this Mac' };
    })()] : [];
    return [...clis, ...apis, ...local];
  }
  resolve(connectionId) {
    const connection = this.connections().find(c => c.id === connectionId);
    if (!connection) throw new Error('This model connection was removed. Choose another model.');
    return { connection, preset: presets[connection.preset] };
  }
  // A CLI's menu is its loaded list (Claude Code from the model catalog, Codex from the CLI) after "CLI default",
  // else the built-in list. Models released in the last 14 days are marked isNew.
  models(connectionId) {
    const { preset } = this.resolve(connectionId);
    if (connectionId === LOCAL_ID) return this.localModels();
    const cached = this.store.data.modelCache[connectionId]?.models;
    const list = preset.kind === 'cli' ? (cached?.length ? [preset.models[0], ...cached.filter(m => m.id)] : preset.models) : cached || [];
    return this.catalog ? list.map(m => (m.id && !m.isNew && this.catalog.isNew(m.id) ? { ...m, isNew: true } : m)) : list;
  }
  localModels() { return (this.local?.library.list() || []).map(m => ({ id: m.id, label: `${m.repo.split('/')[1].replace(/-GGUF$/i, '')} · ${m.quant || 'GGUF'}` })); }
  async refreshModels(connectionId) {
    const { connection, preset } = this.resolve(connectionId);
    if (connectionId === LOCAL_ID) return this.localModels();
    let models;
    if (preset.kind === 'cli') {
      if (preset.cli === 'claude' && this.catalog) { await this.catalog.refresh({ force: true }); models = this.catalog.claudeModels(); }
      else if (preset.cli === 'codex') models = await codexServer.listModels({ executable: cli.cliPath('codex'), env: { ...process.env, PATH: cli.searchPath().join(path.delimiter) } });
      if (!models?.length) return this.models(connectionId);
    } else {
      const key = this.secrets.get(`key:${connectionId}`);
      models = preset.kind === 'anthropic' ? await anthropic.listModels(key) : await openai.listModels(connection.baseURL || preset.baseURL, key, preset.modelsURL);
    }
    this.store.data.modelCache[connectionId] = { at: Date.now(), models };
    this.store.save();
    return this.models(connectionId);
  }
  // Daily: the catalog and the menus of the installed CLIs that can list models. Failures keep the last lists.
  async refreshCatalog() {
    if (this.catalog) await this.catalog.refresh().catch(() => {});
    for (const c of this.connections().filter(c => c.kind === 'cli' && c.ready && ['claude', 'codex'].includes(presets[c.preset].cli))) {
      const at = this.store.data.modelCache[c.id]?.at || 0;
      if (Date.now() - at > 24 * 60 * 60 * 1000) await this.refreshModels(c.id).catch(() => {});
    }
  }

  // Changing provider drops the CLI session; the next turn replays the transcript instead.
  // overseer: true lets the Overseer choose the model of each turn; choosing a model by hand turns it off.
  // baseMode keeps the access mode the user chose, so a route through a provider without that mode does not lose it.
  setThreadSettings(threadId, next) {
    const thread = this.store.thread(threadId);
    if (this.runs.has(threadId)) throw new Error('Wait for the current reply to finish.');
    const connectionId = next.connectionId ?? thread.connectionId;
    const { connection, preset } = this.resolve(connectionId);
    const mode = mapMode(next.mode ?? thread.baseMode ?? thread.mode, preset);
    const effort = preset.efforts.includes(next.effort ?? thread.effort) ? (next.effort ?? thread.effort) : '';
    const settings = validateSettings(connection, { model: next.model ?? thread.model, effort, mode }, this.models(connectionId));
    const switched = connectionId !== thread.connectionId;
    const overseerOn = 'overseer' in next ? !!next.overseer : 'model' in next || 'connectionId' in next ? false : !!thread.overseer;
    this.store.update(threadId, { connectionId, ...settings, baseMode: 'mode' in next ? settings.mode : thread.baseMode ?? settings.mode, overseer: overseerOn,
      ...(overseerOn !== !!thread.overseer ? { route: null } : {}), ...(switched ? { sessionId: null, replay: thread.messages.length > 0 } : {}) });
    this.store.data.preferences.lastModel = { connectionId, ...settings, overseer: overseerOn };
    return this.store.thread(threadId);
  }

  // The models the Overseer may choose from, with the user's exclusions applied (or all, for the settings list).
  overseerCandidates({ all = false } = {}) {
    const prefs = this.store.data.preferences.overseer || {};
    const used = new Set(this.store.data.threads.flatMap(t => t.messages.filter(m => m.role === 'assistant' && !m.error && m.connectionId).map(m => m.connectionId)));
    return overseer.candidates({ connections: this.connections(), modelsOf: id => this.models(id), presets, prefs, used, all, tierOf: this.catalog && (id => this.catalog.tier(id)), priceOf: this.catalog && (id => this.catalog.price(id)) });
  }
  // Picks this turn's model and moves the thread to it. Returns the route, or null when the thread keeps its model.
  async route(threadId, { text, workspace, files, history, signal }) {
    const thread = this.store.thread(threadId);
    const prefs = this.store.data.preferences.overseer || {};
    const list = this.overseerCandidates();
    if (!list.length) return null;
    const router = this.connections().find(c => c.id === overseer.ROUTER.connectionId && c.ready);
    const complete = router ? (prompt, routerSignal) => cli.complete({ preset: presets[router.preset], model: overseer.ROUTER.model, prompt, signal: routerSignal }) : null;
    const route = await overseer.decide({ text, workspaceKind: workspace.kind, files, previous: thread.route, list, prefs, signal, complete,
      readLimits: name => (this.limits?.supports(name) ? this.limits.get(name) : Promise.resolve(null)) });
    if (!route) return null;
    const { connection, preset } = this.resolve(route.connectionId);
    const switched = route.connectionId !== thread.connectionId;
    const settings = validateSettings(connection, { model: route.model, effort: preset.efforts.includes(route.effort) ? route.effort : '', mode: mapMode(thread.baseMode ?? thread.mode, preset) }, this.models(route.connectionId));
    this.store.update(threadId, { connectionId: route.connectionId, ...settings, route, ...(switched ? { sessionId: null, replay: history.length > 0 } : {}) });
    this.send('thread-changed', { threadId });
    this.send('changed');
    return route;
  }

  // Validation throws synchronously so the caller sees it; the run itself continues in the background.
  start(threadId, { text, images = [], files = [] }) {
    text = String(text || '').trim();
    if (!text && !images.length && !files.length) throw new Error('Write a message first.');
    // Attachments must already be copied into this thread's folder (files:attach).
    const inbox = this.files && this.files.dir(threadId, 'in') + path.sep;
    const attached = files.map(f => {
      const file = path.resolve(String(f?.path || ''));
      if (!inbox || !file.startsWith(inbox) || !fs.existsSync(file)) throw new Error(`Attach ${f?.name || 'the file'} again.`);
      return { type: 'file', name: path.basename(file), path: file, size: fs.statSync(file).size, mediaType: mediaType(file) };
    });
    if (this.runs.has(threadId)) throw new Error('This conversation is already running.');
    const thread = this.store.thread(threadId);
    const workspace = this.store.workspace(thread.workspaceId);
    if (!fs.existsSync(workspace.path)) throw new Error('The workspace folder is missing.');
    const { connection, preset } = this.resolve(thread.connectionId);
    if (!connection.ready) throw new Error(`${connection.name}: ${connection.detail}.`);
    if (preset.kind !== 'cli' && !thread.model) throw new Error('Choose a model first.');
    // @path mentions of workspace files go with the message like attachments, read where they are.
    for (const part of commands.mentions(text, workspace.path)) if (!attached.some(p => p.path === part.path)) attached.push(part);

    const history = thread.messages.slice();
    const user = this.store.append(threadId, { role: 'user', parts: [...images.map(i => ({ type: 'image', mediaType: i.mediaType, data: i.data, name: i.name })), ...attached, ...(text ? [{ type: 'text', text }] : [])] });
    const draft = new Draft();
    const controller = new AbortController();
    this.runs.set(threadId, { controller, draft, startedAt: Date.now() });
    this.send('thread-changed', { threadId });
    this.send('run-state', { threadId, running: true, startedAt: this.runs.get(threadId).startedAt });
    this.execute({ threadId, thread, workspace, connection, preset, history, text, attached, draft, controller, userId: user.id });
  }

  async execute({ threadId, thread, workspace, connection, preset, history, text, attached = [], draft, controller, userId }) {
    // The Overseer picks this turn's model before anything runs. A failed route keeps the current model.
    let route = null;
    if (thread.overseer) {
      route = await this.route(threadId, { text, workspace, files: attached.length, history, signal: controller.signal }).catch(() => null);
      if (route) ({ connection, preset } = this.resolve((thread = this.store.thread(threadId)).connectionId));
    }
    // A file checkpoint before the model acts makes "Rewind code" possible. Folders outside Git have none.
    // Chats and projects are not code folders, so they get no checkpoints.
    const chat = workspace.kind === 'chats' || workspace.kind === 'project';
    const checkpoint = chat ? null : await git.snapshot(workspace.path).catch(() => null);
    if (checkpoint) this.store.patchMessage(threadId, userId, { checkpoint });
    // A /name file command or skill becomes its prompt text. The message shows what the user typed.
    const expanded = await commands.expand(text, workspace.path, preset.cli).catch(() => null);
    if (expanded) { this.store.patchMessage(threadId, userId, { prompt: expanded }); text = expanded; }
    let sent = -1;
    const ticker = setInterval(() => { if (draft.version !== sent) { sent = draft.version; this.send('run-update', { threadId, parts: draft.parts }); } }, UPDATE_MS);
    const finish = message => {
      clearInterval(ticker);
      const startedAt = this.runs.get(threadId)?.startedAt;
      this.runs.delete(threadId);
      for (const [id, entry] of this.approvals) if (entry.threadId === threadId) this.answer(id, null);
      const saved = message && this.store.append(threadId, { role: 'assistant', connectionId: thread.connectionId, model: thread.model, ...(route ? { route: { reason: route.reason, by: route.by, effort: thread.effort } } : {}), ...(draft.suggestions.length ? { suggestions: draft.suggestions } : {}), ...(startedAt ? { duration: Date.now() - startedAt } : {}), ...(draft.usage ? { usage: { used: draft.usage.used, window: draft.usage.window || contextWindow(thread.model) } } : {}), ...message });
      this.send('thread-changed', { threadId });
      this.send('run-state', { threadId, running: false, error: message?.error });
      return saved;
    };

    try {
      const messages = this.store.thread(threadId).messages;
      const common = { thread, history: messages, draft, signal: controller.signal };
      // CLI agents get this message's attachment text and paths in the prompt; API models get every attachment through the transcript.
      const attachments = this.files ? await this.files.promptTexts(preset.kind === 'cli' ? [{ parts: attached }] : messages) : new Map();
      let result, saved;
      // Claude Code's suggestion can arrive after the reply is saved; it goes first in the list.
      const onSuggestion = suggestion => { if (saved) this.addSuggestions(threadId, saved.id, [suggestion], true); else draft.suggestions = [...new Set([...draft.suggestions, suggestion])]; };
      if (preset.kind === 'cli') {
        result = await cli.run({ ...common, preset, history, prompt: [attachmentBlock(attached, attachments, { paths: true }), text].filter(Boolean).join('\n\n'), cwd: workspace.path, chat, mcpServers: this.mcp.enabledConfigs(), onSuggestion,
          onSession: id => { if (id !== thread.sessionId) this.store.update(threadId, { sessionId: id, replay: false }); },
          approve: request => this.ask(threadId, { server: preset.name, ...request }),
          question: request => this.question(threadId, { server: preset.name, ...request }) });
      } else {
        // A small local model misuses Orin's own tools (a 0.5B model asked about 50 junk questions in a row), and their
        // text costs about 1,600 tokens of prompt on every first turn. Local models get only the connectors the user added.
        const local = connection.id === LOCAL_ID;
        const tools = [...await this.mcp.tools(), ...(local ? [] : [ASK_TOOL, ...(this.files ? [WRITE_TOOL] : [])])];
        const system = [this.store.data.preferences.systemPrompt, workspace.kind === 'project' ? await projects.apiContext(workspace) : ''].filter(Boolean).join('\n\n');
        const api = { ...common, attachments, apiKey: this.secrets.get(`key:${connection.id}`), system: system || undefined, tools, callTool: this.toolCaller(threadId, tools, draft) };
        // A downloaded model needs the engine running with it. The thinking text shows while it loads into memory.
        const baseURL = local ? await this.local.engine.use(thread.model, { signal: controller.signal, onStatus: text => draft.write('thinking', `${text}\n`) }) : connection.baseURL || preset.baseURL;
        try { result = preset.kind === 'anthropic' ? await anthropic.run(api) : await openai.run({ ...api, baseURL }); }
        finally { if (local) this.local.engine.done(); }
      }
      const stopped = controller.signal.aborted;
      saved = finish(stopped && !draft.parts.length ? null : { parts: draft.final(), native: result?.native, ...(stopped ? { stopped: true } : {}) });
      // Claude Code makes one suggestion of its own. With the setting on, every model makes up to three with one extra request.
      // Suggestions from a local model would load it again and take minutes on a small Mac, so they are skipped.
      if (saved && !stopped && !saved.error && connection.id !== LOCAL_ID && this.store.data.preferences.suggestReplies) this.suggestReplies(threadId, connection, preset, saved).catch(() => {});
    } catch (error) {
      // A user stop is not a failure: keep whatever arrived and mark it stopped.
      if (controller.signal.aborted) finish(draft.parts.length ? { parts: draft.final(), stopped: true } : null);
      else finish({ parts: draft.final(), error: error.message || String(error) });
    }
  }
  // One extra request to the same model; CLIs run once without a session or tools. A failure only means no suggestions.
  async suggestReplies(threadId, connection, preset, reply) {
    const thread = this.store.thread(threadId);
    const user = thread.messages.findLast(m => m.role === 'user');
    const request = { apiKey: this.secrets.get(`key:${connection.id}`), model: thread.model, prompt: suggest.prompt(user, reply), signal: AbortSignal.timeout(preset.kind === 'cli' ? 90000 : 30000) };
    const text = preset.kind === 'cli' ? await cli.complete({ preset, ...request })
      : preset.kind === 'anthropic' ? await anthropic.complete(request) : await openai.complete({ ...request, baseURL: connection.baseURL || preset.baseURL });
    this.addSuggestions(threadId, reply.id, suggest.parse(text));
  }
  // Suggestions only matter on the latest reply. Claude Code's own suggestion stays first.
  addSuggestions(threadId, replyId, list, first = false) {
    const reply = this.store.thread(threadId).messages.at(-1);
    if (!list.length || reply?.id !== replyId) return;
    const own = reply.suggestions || [];
    const suggestions = [...new Set(first ? [...list, ...own] : [...own, ...list])].slice(0, suggest.MAX + 1);
    this.store.patchMessage(threadId, replyId, { suggestions });
    this.send('thread-changed', { threadId });
  }

  // Rewinds to just before a user message: the conversation, the files, or both. Returns the message text for the composer.
  // The CLI session continued past that point, so the next turn starts a new session from the transcript.
  async rewind(threadId, messageId, { conversation = true, code = false } = {}) {
    if (this.runs.has(threadId)) throw new Error('Stop the reply first.');
    const thread = this.store.thread(threadId);
    const index = thread.messages.findIndex(m => m.id === messageId && m.role === 'user');
    if (index < 0) throw new Error('Message not found.');
    const message = thread.messages[index];
    let files = null;
    if (code) {
      if (!message.checkpoint) throw new Error('This message has no file checkpoint. Checkpoints exist only in Git workspaces.');
      files = await git.restore(this.store.workspace(thread.workspaceId).path, message.checkpoint);
    }
    if (conversation) this.store.update(threadId, { messages: thread.messages.slice(0, index), sessionId: null, replay: index > 0 });
    return { text: message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n\n'), files };
  }
  stop(threadId) { this.runs.get(threadId)?.controller.abort(); }
  stopAll() { for (const run of this.runs.values()) run.controller.abort(); }

  // Each MCP call asks the user first unless the thread allows all tools.
  toolCaller(threadId, tools, draft) {
    const byName = new Map(tools.map(t => [t.qualified, t]));
    return async (callId, name, input) => {
      const tool = byName.get(name);
      if (tool === ASK_TOOL) {
        draft.setStatus(callId, 'pending');
        const questions = normalizeQuestions(input?.questions);
        if (!questions.length) { const result = { output: 'Give 1 to 4 questions, each with 2 to 4 options.', isError: true }; draft.toolResult(callId, result); return result; }
        const answers = await this.question(threadId, { callId, server: 'Orin', questions }).decision;
        const result = answers ? { output: JSON.stringify(Object.fromEntries(questions.map(q => [q.question, answers[q.id].join(', ')]))) } : { output: SKIPPED, isError: true };
        draft.toolResult(callId, result);
        return result;
      }
      if (tool === WRITE_TOOL) {
        try {
          const file = await this.files.write(threadId, input?.name, input?.content);
          const result = { output: `Saved ${file.name} (${file.size} bytes). The user sees it as a file card with Preview and Download.` };
          draft.toolResult(callId, result); draft.file(file);
          return result;
        } catch (error) { const result = { output: error.message, isError: true }; draft.toolResult(callId, result); return result; }
      }
      if (!tool) { const result = { output: `Unknown tool ${name}.`, isError: true }; draft.toolResult(callId, result); return result; }
      if (this.store.thread(threadId).mode !== 'full') {
        draft.setStatus(callId, 'pending');
        const decision = await this.ask(threadId, { callId, name, server: tool.server, tool: tool.name, input }).decision;
        if (decision === 'deny') { const result = { output: 'The user declined this tool call.', isError: true }; draft.toolResult(callId, { ...result, status: 'denied' }); return result; }
        draft.setStatus(callId, 'running');
      }
      try { const result = await this.mcp.call(tool, input); draft.toolResult(callId, result); return result; }
      catch (error) { const result = { output: error.message, isError: true }; draft.toolResult(callId, result); return result; }
    };
  }
  // One approval flow for MCP calls and CLI permission prompts. A tool the user always allowed in this thread passes at once.
  // Returns { decision, cancel }; cancel denies and removes the request, for example when the CLI withdraws it.
  ask(threadId, { name, ...request }) {
    if ((this.store.thread(threadId).allowedTools || []).includes(name)) return { decision: Promise.resolve('allow'), cancel() {} };
    const id = crypto.randomUUID();
    const decision = new Promise(resolve => {
      this.approvals.set(id, { threadId, resolve });
      this.send('approval', { id, threadId, ...request });
    }).then(answer => {
      const allowed = this.store.thread(threadId).allowedTools || [];
      if (answer === 'always' && !allowed.includes(name)) this.store.update(threadId, { allowedTools: [...allowed, name] });
      return answer;
    });
    return { decision, cancel: () => this.answer(id, 'deny') };
  }
  // Questions from the model: Claude Code's AskUserQuestion, Codex user input requests, and the ask_user tool of API runs.
  // Resolves to { [question id]: [answer, …] }, or null when the user skips or the run ends.
  question(threadId, { questions, ...request }) {
    questions = normalizeQuestions(questions);
    const id = crypto.randomUUID();
    const decision = new Promise(resolve => {
      this.approvals.set(id, { threadId, resolve, questions });
      this.send('question', { id, threadId, questions, ...request });
    });
    return { decision, cancel: () => this.answer(id, null) };
  }
  answer(approvalId, decision) {
    const entry = this.approvals.get(approvalId);
    if (!entry) return;
    this.approvals.delete(approvalId);
    this.send('approval-done', { id: approvalId });
    if (entry.questions) entry.resolve(validAnswers(entry.questions, decision));
    else entry.resolve(['allow', 'always', 'deny'].includes(decision) ? decision : 'deny');
  }
  live() { return Object.fromEntries([...this.runs].map(([id, run]) => [id, run.draft.parts])); }
  startedAt(threadId) { return this.runs.get(threadId)?.startedAt || null; }
}

// The closest access mode a provider has to the one the user chose. CLIs and API models have different modes.
function mapMode(mode, preset) {
  const available = modesFor(preset);
  if (available.some(m => m.id === mode)) return mode;
  if (mode === 'full' && available.some(m => m.id === 'full')) return 'full';
  if (preset.kind === 'cli') return available.find(m => m.id === (mode === 'ask' ? 'default' : 'auto'))?.id || available[0].id;
  return available[0].id;
}

module.exports = { Runner, mapMode, ASK_TOOL, WRITE_TOOL, normalizeQuestions, validAnswers };
