const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
function cliPath(provider) {
  const filename = provider;
  const home = process.env.HOME || '';
  const candidates = [
    path.join(home, '.local/bin', filename),
    path.join(home, '.npm-global/bin', filename),
    ...((process.env.PATH || '').split(path.delimiter).map(p => path.join(p, filename))),
    ...((() => { try { return fs.readdirSync(path.join(home, '.nvm/versions/node')).map(v => path.join(home, '.nvm/versions/node', v, 'bin', filename)).reverse(); } catch { return []; } })()),
    '/opt/homebrew/bin/' + filename, '/usr/local/bin/' + filename
  ];
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}
function available() { return Object.keys(names).map(id => ({ id, name: names[id], installed: !!cliPath(id) })); }
function command(provider, prompt, sessionId, settings = {}) {
  const { model = '', effort = '', mode = 'auto' } = settings;
  const modelArgs = model ? ['--model', model] : [];
  if (provider === 'claude') {
    const permission = { default: [], read: ['--permission-mode', 'plan'], auto: ['--permission-mode', 'acceptEdits'], full: ['--permission-mode', 'bypassPermissions'] }[mode];
    return ['-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...permission, ...modelArgs, ...(effort ? ['--effort', effort] : []), ...(sessionId ? ['--resume', sessionId] : [])];
  }
  if (provider === 'codex') {
    const access = { default: [], read: ['--sandbox', 'read-only', '-c', 'approval_policy="never"'], auto: ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"'], full: ['--dangerously-bypass-approvals-and-sandbox'] }[mode];
    return ['exec', '--json', '--skip-git-repo-check', ...access, ...modelArgs, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), ...(sessionId ? ['resume', sessionId] : []), prompt];
  }
  if (provider === 'gemini') {
    const access = { default: ['--approval-mode', 'default'], read: ['--approval-mode', 'plan'], auto: ['--approval-mode', 'auto_edit'], full: ['--approval-mode', 'yolo'] }[mode];
    return ['-p', prompt, '--output-format', 'stream-json', ...access, ...modelArgs, ...(sessionId ? ['--resume', sessionId] : [])];
  }
  throw new Error('Unknown provider.');
}
function skills(cwd) {
  const home = process.env.HOME || '';
  const locations = [
    ['Claude', path.join(home, '.claude/skills')], ['Codex', path.join(home, '.codex/skills')], ['Gemini', path.join(home, '.gemini/skills')],
    ...(cwd ? [['Workspace', path.join(cwd, '.agents/skills')], ['Workspace', path.join(cwd, '.claude/skills')], ['Workspace', path.join(cwd, '.gemini/skills')]] : [])
  ];
  return locations.flatMap(([provider, folder]) => {
    try { return fs.readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(folder, e.name, 'SKILL.md'))).map(e => ({ provider, name: e.name, path: path.join(folder, e.name) })); }
    catch { return []; }
  });
}
function textParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part.type === 'text').map(part => part.text || '').join('\n');
}
function normalize(provider, event) {
  if (provider === 'claude') {
    if (event.type === 'system' && event.session_id) return { kind: 'session', id: event.session_id };
    if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') return { kind: 'partial', text: event.event.delta.text || '' };
    if (event.type === 'assistant') {
      const text = textParts(event.message?.content);
      const tools = (event.message?.content || []).filter(p => p.type === 'tool_use');
      return { kind: 'activity', text, tools: tools.map(t => ({ name: t.name, detail: JSON.stringify(t.input || {}) })) };
    }
    if (event.type === 'result') return { kind: 'result', text: event.result || '', id: event.session_id };
  } else if (provider === 'codex') {
    if (event.type === 'thread.started') return { kind: 'session', id: event.thread_id };
    if (event.type === 'item.completed' || event.type === 'item.updated') {
      const item = event.item || {};
      if (item.type === 'agent_message') return { kind: 'activity', text: item.text || '' };
      if (item.type === 'command_execution') return { kind: 'activity', tools: [{ name: 'Command', detail: item.command || '' }] };
      if (item.type === 'file_change') return { kind: 'activity', tools: [{ name: 'File change', detail: JSON.stringify(item.changes || []) }] };
    }
    if (event.type === 'turn.failed') return { kind: 'error', text: event.error?.message || 'Turn failed.' };
  } else if (provider === 'gemini') {
    if (event.type === 'init') return { kind: 'session', id: event.session_id };
    if (event.type === 'message' && event.role === 'assistant') return { kind: 'activity', text: event.content || '' };
    if (event.type === 'tool_use') return { kind: 'activity', tools: [{ name: event.tool_name || 'Tool', detail: JSON.stringify(event.parameters || {}) }] };
    if (event.type === 'result') return { kind: 'result', text: event.response || '' };
    if (event.type === 'error') return { kind: 'error', text: event.message || 'Gemini error.' };
  }
  return null;
}
function replayPrompt(messages, prompt) {
  const context = messages.filter(m => ['user', 'assistant'].includes(m.role)).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n\n');
  return `Continue this earlier conversation. Its transcript is included for context; check the current files before changing them.\n\n${context.slice(-40000)}\n\nUser: ${prompt}`;
}
function run({ provider, cwd, prompt, sessionId, settings, onEvent }) {
  const executable = cliPath(provider);
  if (!executable) throw new Error(`${names[provider]} CLI is not installed or not on PATH.`);
  const child = spawn(executable, command(provider, prompt, sessionId, settings), { cwd, env: { ...process.env, PATH: path.dirname(executable) + path.delimiter + (process.env.PATH || ''), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line.trim()) continue;
      try { const normalized = normalize(provider, JSON.parse(line)); if (normalized) onEvent(normalized); }
      catch { onEvent({ kind: 'activity', text: line }); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16000) stderr = stderr.slice(-16000); });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      if (pending.trim()) { try { const event = normalize(provider, JSON.parse(pending)); if (event) onEvent(event); } catch {} }
      if (code === 0) resolve(); else reject(new Error(stderr.trim() || `${names[provider]} exited with code ${code}.`));
    });
  });
  return { done, stop: () => child.kill('SIGTERM') };
}
module.exports = { available, command, normalize, replayPrompt, run, skills };
