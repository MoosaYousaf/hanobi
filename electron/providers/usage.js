const fs = require('node:fs');
const path = require('node:path');

// Context usage of the last model call in a turn: { used, window }. used = every token the model saw plus its output.
// window is null when neither the provider nor the table below knows the model's context size.

// Claude models: 1M, except Haiku 4.5 and older models with 200K. Other API models report no size.
function contextWindow(model = '') {
  if (/claude-(haiku-4|3|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|opus-4$|sonnet-4$)/.test(model)) return 200000;
  if (/claude/.test(model)) return 1000000;
  return null;
}

// Reads the end of a file only; session logs can grow to many megabytes.
function tail(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8').split('\n');
  } finally { fs.closeSync(fd); }
}
const lastMatch = (lines, pick) => { for (let i = lines.length - 1; i >= 0; i--) { try { const found = pick(JSON.parse(lines[i])); if (found) return found; } catch {} } return null; };

// Codex writes token_count events to ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl.
function codex(threadId, home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex')) {
  const root = path.join(home, 'sessions');
  const newest = dir => { try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; } };
  for (const y of newest(root)) for (const m of newest(path.join(root, y))) for (const d of newest(path.join(root, y, m))) {
    const name = newest(path.join(root, y, m, d)).find(f => f.endsWith(`${threadId}.jsonl`));
    if (!name) continue;
    return lastMatch(tail(path.join(root, y, m, d, name)), e => {
      const info = e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload.info;
      const last = info?.last_token_usage;
      return last ? { used: (last.input_tokens || 0) + (last.output_tokens || 0), window: info.model_context_window || null } : null;
    });
  }
  return null;
}

// Copilot writes session.usage_record events to ~/.copilot/session-state/<session id>/events.jsonl.
function copilot(sessionId, home = path.join(process.env.HOME || '', '.copilot')) {
  const file = path.join(home, 'session-state', sessionId, 'events.jsonl');
  if (!sessionId || !fs.existsSync(file)) return null;
  return lastMatch(tail(file), e => {
    const u = e.type === 'session.usage_record' && e.data?.usage;
    return u ? { used: (u.inputTokens || 0) + (u.outputTokens || 0), window: u.maxPromptTokens || null } : null;
  });
}

function fromSession(cli, sessionId) {
  if (!sessionId) return null;
  try { return cli === 'codex' ? codex(sessionId) : cli === 'copilot' ? copilot(sessionId) : null; } catch { return null; }
}

module.exports = { contextWindow, fromSession, codex, copilot, tail, lastMatch };
