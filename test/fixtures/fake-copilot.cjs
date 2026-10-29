#!/usr/bin/env node
// Acts as `copilot --acp`: one edit that needs permission, then a reply that names the chosen option.
const readline = require('node:readline');
const out = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
if (process.argv[2] !== '--acp') { console.error('expected --acp'); process.exit(2); }
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } });
const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'all', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }];
let prompt = null, allowAll = process.env.FAKE_ALLOW_ALL || 'off';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (m.method === 'session/new') out({ id: m.id, result: { sessionId: 's-new', configOptions: [{ id: 'allow_all', currentValue: allowAll }] } });
  else if (m.method === 'session/load') {
    // A load replays the earlier turn before it answers.
    update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' } });
    out({ id: m.id, result: { configOptions: [{ id: 'allow_all', currentValue: allowAll }] } });
  } else if (m.method === 'session/set_config_option') { allowAll = m.params.value; out({ id: m.id, result: {} }); }
  else if (m.method === 'session/prompt') {
    if (allowAll !== 'off') { out({ id: m.id, error: { code: -1, message: 'allow_all is on' } }); return; }
    prompt = m;
    const s = m.params.sessionId;
    update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } });
    update(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Create a.txt', kind: 'edit', status: 'pending', rawInput: { path: 'a.txt' } });
    out({ id: 'p1', method: 'session/request_permission', params: { sessionId: s, toolCall: { toolCallId: 't1', title: 'Create a.txt', kind: 'edit' }, options } });
  } else if (m.id === 'p1') {
    const s = prompt.params.sessionId, chosen = m.result.outcome.optionId;
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: chosen === 'yes' ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: chosen === 'yes' ? 'written' : 'rejected' } }] });
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${s}:${chosen}` } });
    out({ id: prompt.id, result: { stopReason: 'end_turn' } });
  }
});
