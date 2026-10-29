const { spawn } = require('node:child_process');

// Copilot "Ask first" runs `copilot --acp`: Agent Client Protocol, JSON-RPC lines on stdio. With allow_all off,
// Copilot asks before tools, paths, and URLs with session/request_permission. Session ids are the same as `--session-id`.
// Hanobi declares no fs or terminal capability, so Copilot uses its own tools and asks for permission.
const KINDS = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Command', fetch: 'Fetch', think: 'Think' };

const toolName = call => KINDS[call.kind] || call.title || 'Tool';
// Tool output is a list of content blocks, diffs, and terminals. Only text and diffs are shown.
const contentText = list => (list || []).map(c => (c.type === 'content' ? (c.content?.text ?? '') : c.type === 'diff' ? `${c.path}\n${c.newText ?? ''}` : '')).filter(Boolean).join('\n');
const asText = value => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));

// Applies one session/update to the draft. Copilot sends notices ("Info: …") as whole message chunks with no
// marker, so each notice gets its own paragraph; state.notice is true while the last text was a notice.
function apply(update, draft, state = {}) {
  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
    const text = update.content.text, notice = /^Info: /.test(text), gap = draft.last('text')?.text && (notice || state.notice) ? '\n\n' : '';
    draft.write('text', gap + text);
    state.notice = notice;
  }
  else if (kind === 'agent_thought_chunk' && update.content?.type === 'text') draft.write('thinking', update.content.text);
  else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = update.toolCallId;
    const shown = draft.parts.find(p => p.type === 'tool' && p.id === id);
    if (!shown && kind === 'tool_call') draft.tool({ id, name: toolName(update), input: update.rawInput ?? update.title });
    else if (shown && update.rawInput !== undefined) draft.tool({ id, input: update.rawInput });
    if (update.status === 'completed' || update.status === 'failed') {
      if (shown?.status === 'denied') return;
      draft.toolResult(id, { output: contentText(update.content) || asText(update.rawOutput), isError: update.status === 'failed' });
    }
  }
}

// The chosen option of a permission request. Hanobi keeps "always" itself, so only the once options are used.
function choose(options, answer) {
  const order = answer === 'deny' ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always'];
  const option = order.map(kind => options.find(o => o.kind === kind)).find(Boolean);
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}

function run({ executable, env, cwd, input, resume, model, effort, draft, signal, onSession, approve }) {
  const args = ['--acp', '--disable-client-telemetry', ...(model ? ['--model', model] : []), ...(effort ? ['--reasoning-effort', effort] : [])];
  const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const write = message => { if (child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  const calls = new Map(); // request id -> { resolve, reject }
  const asking = new Map(); // agent request id -> cancel
  let nextId = 1, sessionId = null, loading = false, failure = null, stderr = '';
  const state = {};
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; calls.set(id, { resolve, reject }); write({ id, method, params }); });

  // A permission request waits for the user; anything else gets an error so the turn does not hang.
  const serve = message => {
    if (message.method !== 'session/request_permission' || !approve) { write({ id: message.id, error: { code: -32601, message: `Hanobi does not handle ${message.method}.` } }); return; }
    const { toolCall = {}, options = [] } = message.params || {};
    const callId = toolCall.toolCallId;
    const shown = draft.parts.find(p => p.type === 'tool' && p.id === callId);
    const name = shown?.name || toolName(toolCall);
    const input = toolCall.rawInput ?? shown?.input ?? toolCall.title;
    draft.tool({ id: callId, name, input });
    draft.setStatus(callId, 'pending');
    const { decision, cancel } = approve({ callId, name, tool: name, input, description: toolCall.title });
    asking.set(message.id, cancel);
    decision.then(answer => {
      asking.delete(message.id);
      draft.setStatus(callId, answer === 'deny' ? 'denied' : 'running');
      write({ id: message.id, result: { outcome: choose(options, answer) } });
    });
  };
  const handle = line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) serve(message);
    // session/load replays the earlier turns as updates; the thread already shows them.
    else if (message.method === 'session/update' && !loading) apply(message.params?.update || {}, draft, state);
    else if (calls.has(message.id)) {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message || 'GitHub Copilot ACP error.'));
      else call.resolve(message.result);
    }
  };
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    lines.forEach(handle);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const exited = new Promise(resolve => {
    child.on('error', error => { failure ||= error; resolve(); });
    child.on('close', code => {
      for (const call of calls.values()) call.reject(new Error(stderr.trim() || `GitHub Copilot exited with code ${code}.`));
      calls.clear();
      resolve();
    });
  });
  // Stop cancels the turn and every open permission request, then ends the process.
  const stop = () => {
    if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
    for (const cancel of asking.values()) cancel();
    child.kill('SIGTERM');
  };
  signal.addEventListener('abort', stop, { once: true });

  const turn = (async () => {
    await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'hanobi', title: 'Hanobi', version: '1' } });
    let session;
    if (resume) {
      loading = true;
      session = await request('session/load', { sessionId: resume, cwd, mcpServers: [] });
      loading = false;
      sessionId = resume;
    } else {
      session = await request('session/new', { cwd, mcpServers: [] });
      sessionId = session.sessionId;
    }
    onSession(sessionId);
    // A saved Copilot setting can turn allow_all on; Ask first needs it off.
    if (session?.configOptions?.some(o => o.id === 'allow_all' && o.currentValue === 'on')) await request('session/set_config_option', { sessionId, configId: 'allow_all', value: 'off' });
    return request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input }] });
  })();

  return turn.then(() => null, error => error).then(async error => {
    signal.removeEventListener('abort', stop);
    child.kill('SIGTERM');
    await exited;
    if (signal.aborted) return { stopped: true };
    if (error || failure) throw error || failure;
    return {};
  });
}

module.exports = { apply, choose, run };
