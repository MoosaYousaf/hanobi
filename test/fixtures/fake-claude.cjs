#!/usr/bin/env node
// Acts as Claude Code in ask mode: one Bash call that needs approval, then a result that names the decision.
const readline = require('node:readline');
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
if (!process.argv.includes('--permission-prompt-tool')) { console.error('expected --permission-prompt-tool stdio'); process.exit(2); }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const event = JSON.parse(line);
  if (event.type === 'user' && event.message.content === 'ask') {
    out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
    const input = { questions: [{ question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }] };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input }] } });
    out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'q1' } });
  } else if (event.type === 'user') {
    out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: event.message.content } }] } });
    out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: event.message.content }, tool_use_id: 't1', description: 'Run a command' } });
  } else if (event.type === 'control_response') {
    const { behavior, message, updatedInput } = event.response.response;
    if (updatedInput?.questions) { out({ type: 'result', result: behavior === 'allow' ? JSON.stringify(updatedInput.answers) : message, session_id: 'fake-session' }); return; }
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: behavior === 'allow' ? 'ran' : message, is_error: behavior !== 'allow' }] } });
    out({ type: 'result', result: behavior, session_id: 'fake-session' });
  }
});
