const fs = require('node:fs');
const crypto = require('node:crypto');
const { presets, modes, modeGroup, validateSettings } = require('./providers/catalog');
const { Draft } = require('./draft');
const cli = require('./providers/cli');
const anthropic = require('./providers/anthropic');
const openai = require('./providers/openai');

const UPDATE_MS = 60;

class Runner {
  constructor({ store, secrets, mcp, send }) {
    Object.assign(this, { store, secrets, mcp, send });
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
    const group = modeGroup(preset.kind);
    const mode = modes[group].some(m => m.id === (next.mode ?? thread.mode)) ? (next.mode ?? thread.mode) : modes[group][0].id;
    const effort = preset.efforts.includes(next.effort ?? thread.effort) ? (next.effort ?? thread.effort) : '';
    const settings = validateSettings(connection, { model: next.model ?? thread.model, effort, mode });
    const switched = connectionId !== thread.connectionId;
    this.store.update(threadId, { connectionId, ...settings, ...(switched ? { sessionId: null, replay: thread.messages.length > 0 } : {}) });
    this.store.data.preferences.lastModel = { connectionId, ...settings };
    return this.store.thread(threadId);
  }

  // Validation throws synchronously so the caller sees it; the run itself continues in the background.
  start(threadId, { text, images = [] }) {
    text = String(text || '').trim();
    if (!text && !images.length) throw new Error('Write a message first.');
    if (this.runs.has(threadId)) throw new Error('This conversation is already running.');
    const thread = this.store.thread(threadId);
    const workspace = this.store.workspace(thread.workspaceId);
    if (!fs.existsSync(workspace.path)) throw new Error('The workspace folder is missing.');
    const { connection, preset } = this.resolve(thread.connectionId);
    if (!connection.ready) throw new Error(`${connection.name}: ${connection.detail}.`);
    if (preset.kind !== 'cli' && !thread.model) throw new Error('Choose a model first.');

    const history = thread.messages.slice();
    this.store.append(threadId, { role: 'user', parts: [...images.map(i => ({ type: 'image', mediaType: i.mediaType, data: i.data, name: i.name })), ...(text ? [{ type: 'text', text }] : [])] });
    const draft = new Draft();
    const controller = new AbortController();
    this.runs.set(threadId, { controller, draft });
    this.send('thread-changed', { threadId });
    this.send('run-state', { threadId, running: true });
    this.execute({ threadId, thread, workspace, connection, preset, history, text, draft, controller });
  }

  async execute({ threadId, thread, workspace, connection, preset, history, text, draft, controller }) {
    let sent = -1;
    const ticker = setInterval(() => { if (draft.version !== sent) { sent = draft.version; this.send('run-update', { threadId, parts: draft.parts }); } }, UPDATE_MS);
    const finish = message => {
      clearInterval(ticker);
      this.runs.delete(threadId);
      for (const [id, entry] of this.approvals) if (entry.threadId === threadId) { entry.resolve('deny'); this.approvals.delete(id); }
      if (message) this.store.append(threadId, { role: 'assistant', connectionId: thread.connectionId, model: thread.model, ...message });
      this.send('thread-changed', { threadId });
      this.send('run-state', { threadId, running: false, error: message?.error });
    };

    try {
      const common = { thread, history: this.store.thread(threadId).messages, draft, signal: controller.signal };
      let result;
      if (preset.kind === 'cli') {
        result = await cli.run({ ...common, preset, history, prompt: text, cwd: workspace.path, mcpServers: this.mcp.enabledConfigs(),
          onSession: id => { if (id !== thread.sessionId) this.store.update(threadId, { sessionId: id, replay: false }); } });
      } else {
        const tools = await this.mcp.tools();
        const api = { ...common, apiKey: this.secrets.get(`key:${connection.id}`), system: this.store.data.preferences.systemPrompt || undefined, tools, callTool: this.toolCaller(threadId, tools, draft) };
        result = preset.kind === 'anthropic' ? await anthropic.run(api) : await openai.run({ ...api, baseURL: connection.baseURL || preset.baseURL });
      }
      const stopped = controller.signal.aborted;
      finish(stopped && !draft.parts.length ? null : { parts: draft.final(), native: result?.native, ...(stopped ? { stopped: true } : {}) });
    } catch (error) {
      // A user stop is not a failure: keep whatever arrived and mark it stopped.
      if (controller.signal.aborted) finish(draft.parts.length ? { parts: draft.final(), stopped: true } : null);
      else finish({ parts: draft.final(), error: error.message || String(error) });
    }
  }
  stop(threadId) { this.runs.get(threadId)?.controller.abort(); }
  stopAll() { for (const run of this.runs.values()) run.controller.abort(); }

  // Each MCP call asks the user first unless the thread allows all tools or this tool was always allowed.
  toolCaller(threadId, tools, draft) {
    const byName = new Map(tools.map(t => [t.qualified, t]));
    return async (callId, name, input) => {
      const tool = byName.get(name);
      if (!tool) { const result = { output: `Unknown tool ${name}.`, isError: true }; draft.toolResult(callId, result); return result; }
      const thread = this.store.thread(threadId);
      if (thread.mode !== 'full' && !(thread.allowedTools || []).includes(name)) {
        draft.setStatus(callId, 'pending');
        const id = crypto.randomUUID();
        const decision = await new Promise(resolve => {
          this.approvals.set(id, { threadId, resolve });
          this.send('approval', { id, threadId, callId, server: tool.server, tool: tool.name, input });
        });
        if (decision === 'deny') { const result = { output: 'The user declined this tool call.', isError: true }; draft.toolResult(callId, { ...result, status: 'denied' }); return result; }
        if (decision === 'always') this.store.update(threadId, { allowedTools: [...(thread.allowedTools || []), name] });
        draft.setStatus(callId, 'running');
      }
      try { const result = await this.mcp.call(tool, input); draft.toolResult(callId, result); return result; }
      catch (error) { const result = { output: error.message, isError: true }; draft.toolResult(callId, result); return result; }
    };
  }
  answer(approvalId, decision) {
    const entry = this.approvals.get(approvalId);
    if (!entry) return;
    this.approvals.delete(approvalId);
    entry.resolve(['allow', 'always', 'deny'].includes(decision) ? decision : 'deny');
  }
  live() { return Object.fromEntries([...this.runs].map(([id, run]) => [id, run.draft.parts])); }
}

module.exports = { Runner };
