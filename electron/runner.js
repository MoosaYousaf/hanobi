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

const UPDATE_MS = 60;

const SKIPPED = 'The user skipped the questions. Continue with your best judgment, or ask in plain text.';
// API and local models get this tool next to the MCP tools, so any model can ask structured questions.
const ASK_TOOL = {
  qualified: 'hanobi__ask_user', server: 'Hanobi', name: 'ask_user',
  description: 'Ask the user 1 to 4 multiple-choice questions when a decision is theirs to make and you cannot resolve it from context. The user can also type their own answer. Returns the answers, keyed by question text.',
  inputSchema: { type: 'object', required: ['questions'], properties: { questions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['question', 'options'], properties: {
    question: { type: 'string' }, header: { type: 'string', description: 'A label of at most 12 characters.' }, multiSelect: { type: 'boolean' },
    options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' } } } }
  } } } } }
};

// API and local models make files with this tool. The user gets a file card with Preview, Open, and Save.
const WRITE_TOOL = {
  qualified: 'hanobi__write_file', server: 'Hanobi', name: 'write_file',
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
  constructor({ store, secrets, mcp, send, files }) {
    Object.assign(this, { store, secrets, mcp, send, files });
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
    return [...clis, ...apis];
  }
  resolve(connectionId) {
    const connection = this.connections().find(c => c.id === connectionId);
    if (!connection) throw new Error('This model connection was removed. Choose another model.');
    return { connection, preset: presets[connection.preset] };
  }
  models(connectionId) {
    const { preset } = this.resolve(connectionId);
    if (preset.kind === 'cli') return preset.models;
    return this.store.data.modelCache[connectionId]?.models || [];
  }
  async refreshModels(connectionId) {
    const { connection, preset } = this.resolve(connectionId);
    if (preset.kind === 'cli') return preset.models;
    const key = this.secrets.get(`key:${connectionId}`);
    const models = preset.kind === 'anthropic' ? await anthropic.listModels(key) : await openai.listModels(connection.baseURL || preset.baseURL, key, preset.modelsURL);
    this.store.data.modelCache[connectionId] = { at: Date.now(), models };
    this.store.save();
    return models;
  }

  // Changing provider drops the CLI session; the next turn replays the transcript instead.
  setThreadSettings(threadId, next) {
    const thread = this.store.thread(threadId);
    if (this.runs.has(threadId)) throw new Error('Wait for the current reply to finish.');
    const connectionId = next.connectionId ?? thread.connectionId;
    const { connection, preset } = this.resolve(connectionId);
    const available = modesFor(preset);
    const mode = available.some(m => m.id === (next.mode ?? thread.mode)) ? (next.mode ?? thread.mode) : available[0].id;
    const effort = preset.efforts.includes(next.effort ?? thread.effort) ? (next.effort ?? thread.effort) : '';
    const settings = validateSettings(connection, { model: next.model ?? thread.model, effort, mode });
    const switched = connectionId !== thread.connectionId;
    this.store.update(threadId, { connectionId, ...settings, ...(switched ? { sessionId: null, replay: thread.messages.length > 0 } : {}) });
    this.store.data.preferences.lastModel = { connectionId, ...settings };
    return this.store.thread(threadId);
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
      const saved = message && this.store.append(threadId, { role: 'assistant', connectionId: thread.connectionId, model: thread.model, ...(draft.suggestions.length ? { suggestions: draft.suggestions } : {}), ...(startedAt ? { duration: Date.now() - startedAt } : {}), ...(draft.usage ? { usage: { used: draft.usage.used, window: draft.usage.window || contextWindow(thread.model) } } : {}), ...message });
      this.send('thread-changed', { threadId });
      this.send('run-state', { threadId, running: false, error: message?.error });
      return saved;
    };

    try {
      const messages = this.store.thread(threadId).messages;
      const common = { thread, history: messages, draft, signal: controller.signal };
      // CLI agents get this message's attachment text and paths in the prompt; API models get every attachment through the transcript.
      const attachments = this.files ? await this.files.promptTexts(preset.kind === 'cli' ? [{ parts: attached }] : messages) : new Map();
      let result;
      if (preset.kind === 'cli') {
        result = await cli.run({ ...common, preset, history, prompt: [attachmentBlock(attached, attachments, { paths: true }), text].filter(Boolean).join('\n\n'), cwd: workspace.path, chat, mcpServers: this.mcp.enabledConfigs(),
          onSession: id => { if (id !== thread.sessionId) this.store.update(threadId, { sessionId: id, replay: false }); },
          approve: request => this.ask(threadId, { server: preset.name, ...request }),
          question: request => this.question(threadId, { server: preset.name, ...request }) });
      } else {
        const tools = [...await this.mcp.tools(), ASK_TOOL, ...(this.files ? [WRITE_TOOL] : [])];
        const system = [this.store.data.preferences.systemPrompt, workspace.kind === 'project' ? await projects.apiContext(workspace) : ''].filter(Boolean).join('\n\n');
        const api = { ...common, attachments, apiKey: this.secrets.get(`key:${connection.id}`), system: system || undefined, tools, callTool: this.toolCaller(threadId, tools, draft) };
        result = preset.kind === 'anthropic' ? await anthropic.run(api) : await openai.run({ ...api, baseURL: connection.baseURL || preset.baseURL });
      }
      const stopped = controller.signal.aborted;
      const saved = finish(stopped && !draft.parts.length ? null : { parts: draft.final(), native: result?.native, ...(stopped ? { stopped: true } : {}) });
      // Claude Code makes its own suggestions; the other providers make them with one extra request when the user turns it on.
      if (saved && !stopped && preset.cli !== 'claude' && this.store.data.preferences.suggestReplies) this.suggestReplies(threadId, connection, preset, saved).catch(() => {});
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
    const suggestions = suggest.parse(text);
    if (!suggestions.length || this.store.thread(threadId).messages.at(-1)?.id !== reply.id) return;
    this.store.patchMessage(threadId, reply.id, { suggestions });
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
        const answers = await this.question(threadId, { callId, server: 'Hanobi', questions }).decision;
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

module.exports = { Runner, ASK_TOOL, WRITE_TOOL, normalizeQuestions, validAnswers };
