const { spawn } = require('node:child_process');

// Codex "Ask first" runs `codex app-server`: JSON-RPC lines on stdio. The server asks before commands and file
// changes with requests that Hanobi answers after the user decides. Sessions are the same threads that `codex exec` uses.
const POLICY = { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
const NAMES = { 'item/commandExecution/requestApproval': 'Command', 'item/fileChange/requestApproval': 'File change' };

const asText = value => (typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text ?? JSON.stringify(v)).join('\n') : JSON.stringify(value ?? ''));

// Applies one server notification to the draft. Throws when the turn fails.
function apply(method, params, draft) {
  const item = params.item || {};
  if (method === 'item/agentMessage/delta') { draft.streamed.add(params.itemId); draft.write('text', params.delta); }
  else if (method === 'item/reasoning/summaryTextDelta') draft.write('thinking', params.delta);
  else if (method === 'item/started') {
    if (item.type === 'agentMessage' && draft.last('text')?.text) draft.write('text', '\n\n');
    else if (item.type === 'commandExecution') draft.tool({ id: item.id, name: 'Command', input: item.command });
    else if (item.type === 'fileChange') draft.tool({ id: item.id, name: 'File change', input: item.changes });
    else if (item.type === 'mcpToolCall') draft.tool({ id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments });
  } else if (method === 'item/completed') {
    const failed = item.status === 'failed';
    if (item.type === 'agentMessage' && !draft.streamed.has(item.id)) draft.write('text', (draft.last('text')?.text ? '\n\n' : '') + (item.text || ''));
    else if (item.type === 'commandExecution') { draft.tool({ id: item.id, name: 'Command', input: item.command }); draft.toolResult(item.id, { output: item.aggregatedOutput || '', isError: failed || (item.exitCode ?? 0) !== 0 }); }
    else if (item.type === 'fileChange') { draft.tool({ id: item.id, name: 'File change', input: item.changes }); draft.toolResult(item.id, { output: item.status, isError: failed }); }
    else if (item.type === 'mcpToolCall') { draft.tool({ id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments }); draft.toolResult(item.id, { output: item.error?.message ?? asText(item.result?.content), isError: failed }); }
  } else if (method === 'error' && !params.willRetry) throw new Error(params.error?.message || 'Codex error.');
  else if (method === 'turn/completed' && params.turn?.status === 'failed') throw new Error(params.turn.error?.message || 'Codex turn failed.');
}

function run({ executable, env, cwd, input, resume, model, effort, draft, signal, onSession, approve, question }) {
  const child = spawn(executable, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const write = message => { if (child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n'); };
  const calls = new Map(); // request id -> { resolve, reject }
  const asking = new Map(); // server request id -> cancel
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; calls.set(id, { resolve, reject }); write({ id, method, params }); });

  let finished, failure = null, stderr = '';
  const done = new Promise(resolve => { finished = resolve; });
  const fail = error => { failure ||= error; finished(); };

  // A server request waits for the user; anything Hanobi does not handle gets an error so the turn does not hang.
  const serve = message => {
    // A user input request: answers are keyed by question id. An empty answer set means the user skipped.
    if (message.method === 'item/tool/requestUserInput' && question) {
      const p = message.params || {};
      draft.tool({ id: p.itemId, name: 'Question', input: p.questions?.map(q => q.question).join('\n') });
      draft.setStatus(p.itemId, 'pending');
      const { decision, cancel } = question({ callId: p.itemId, questions: p.questions || [] });
      asking.set(message.id, cancel);
      decision.then(answers => {
        asking.delete(message.id);
        draft.toolResult(p.itemId, answers ? { output: Object.values(answers).flat().join('\n') } : { output: 'Skipped', status: 'denied' });
        write({ id: message.id, result: { answers: Object.fromEntries(Object.entries(answers || {}).map(([id, list]) => [id, { answers: list }])) } });
      });
      return;
    }
    const name = NAMES[message.method];
    if (!name || !approve) { write({ id: message.id, error: { code: -32601, message: `Hanobi does not handle ${message.method}.` } }); return; }
    const p = message.params || {};
    const callId = p.itemId;
    const shown = draft.parts.find(part => part.type === 'tool' && part.id === callId);
    draft.tool({ id: callId, name, input: p.command ?? shown?.input });
    draft.setStatus(callId, 'pending');
    const { decision, cancel } = approve({ callId, name, tool: name, input: p.command ?? shown?.input, description: p.reason || (p.cwd ? `In ${p.cwd}` : undefined), blockedPath: p.grantRoot || undefined });
    asking.set(message.id, cancel);
    decision.then(answer => {
      asking.delete(message.id);
      draft.setStatus(callId, answer === 'deny' ? 'denied' : 'running');
      write({ id: message.id, result: { decision: answer === 'deny' ? 'decline' : 'accept' } });
    });
  };
  const handle = line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) serve(message);
    else if (message.method) {
      try { apply(message.method, message.params || {}, draft); } catch (error) { fail(error); }
      // The server withdrew a request, for example because the turn ended.
      if (message.method === 'serverRequest/resolved') { asking.get(message.params?.requestId)?.(); asking.delete(message.params?.requestId); }
      if (message.method === 'turn/completed') finished();
    } else if (calls.has(message.id)) {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message || 'Codex app-server error.'));
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
  child.on('error', fail);
  child.on('close', code => {
    for (const call of calls.values()) call.reject(new Error(stderr.trim() || `Codex app-server exited with code ${code}.`));
    calls.clear();
    fail(new Error(stderr.trim() || `Codex app-server exited with code ${code}.`));
  });
  // Ending the process also rejects open requests, so the handshake cannot keep a stopped run waiting.
  const stop = () => { child.kill('SIGTERM'); finished(); };
  signal.addEventListener('abort', stop, { once: true });

  const turn = (async () => {
    await request('initialize', { clientInfo: { name: 'hanobi', title: 'Hanobi', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } });
    write({ method: 'initialized' });
    const settings = { cwd, ...POLICY, ...(model ? { model } : {}) };
    const started = resume ? await request('thread/resume', { threadId: resume, ...settings, excludeTurns: true }) : await request('thread/start', settings);
    onSession(started.thread.id);
    await request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: input, text_elements: [] }], ...(effort ? { effort } : {}) });
  })().catch(fail);

  return Promise.all([turn, done]).then(() => {
    signal.removeEventListener('abort', stop);
    child.kill('SIGTERM');
    if (signal.aborted) return { stopped: true };
    if (failure) throw failure;
    return {};
  });
}

module.exports = { apply, run, POLICY };
