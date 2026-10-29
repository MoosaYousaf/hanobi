#!/usr/bin/env node
// Acts as `codex app-server`: one command that needs approval, then a reply that names the decision.
const readline = require('node:readline');
const out = message => process.stdout.write(JSON.stringify(message) + '\n');
if (process.argv[2] !== 'app-server') { console.error('expected app-server'); process.exit(2); }
const turn = { threadId: 'th1', turnId: 'tu1' };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== 'untrusted') { out({ id: m.id, error: { message: 'expected untrusted' } }); return; }
    out({ id: m.id, result: { thread: { id: m.params.threadId || 'th1' } } });
  } else if (m.method === 'turn/start' && m.params.input[0].text === 'ask') {
    out({ id: m.id, result: { turn: { id: 'tu1', status: 'inProgress' } } });
    out({ id: 'srv2', method: 'item/tool/requestUserInput', params: { ...turn, itemId: 'u1', isBlocking: true, questions: [{ id: 'db', header: 'Database', question: 'Which database?', isOther: true, isSecret: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }] } });
  } else if (m.id === 'srv2') {
    out({ method: 'item/agentMessage/delta', params: { ...turn, itemId: 'm2', delta: JSON.stringify(m.result.answers) } });
    out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'tu1', status: 'completed', error: null } } });
  } else if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 'tu1', status: 'inProgress' } } });
    out({ method: 'item/started', params: { ...turn, item: { type: 'commandExecution', id: 'c1', command: m.params.input[0].text, status: 'inProgress' } } });
    out({ id: 'srv1', method: 'item/commandExecution/requestApproval', params: { ...turn, itemId: 'c1', command: m.params.input[0].text, cwd: '/w', reason: 'Needs approval' } });
  } else if (m.id === 'srv1') {
    const accepted = m.result.decision === 'accept';
    out({ method: 'serverRequest/resolved', params: { threadId: 'th1', requestId: 'srv1' } });
    out({ method: 'item/completed', params: { ...turn, item: { type: 'commandExecution', id: 'c1', command: 'ls', status: accepted ? 'completed' : 'declined', aggregatedOutput: accepted ? 'a.txt' : null, exitCode: accepted ? 0 : null } } });
    out({ method: 'item/started', params: { ...turn, item: { type: 'agentMessage', id: 'm1', text: '' } } });
    out({ method: 'item/agentMessage/delta', params: { ...turn, itemId: 'm1', delta: m.result.decision } });
    out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'tu1', status: 'completed', error: null } } });
  }
});
