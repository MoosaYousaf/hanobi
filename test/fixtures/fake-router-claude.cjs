#!/usr/bin/env node
// Acts as Claude Code for Overseer tests. With --no-session-persistence (a one-off request) it is the router: it counts the call in
// $ROUTER_LOG and picks Sonnet 5.5. Otherwise it answers each message with the arguments it got.
const fs = require('node:fs');
const readline = require('node:readline');
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
if (process.argv.includes('--no-session-persistence')) {
  fs.appendFileSync(process.env.ROUTER_LOG, 'route\n');
  const text = '{"id": "claude-code::claude-sonnet-5-5", "effort": "low", "reason": "Fake router"}';
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', result: text });
  process.exit(0);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (JSON.parse(line).type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: 'router-session' });
  const text = process.argv.slice(2).join(' ');
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', result: text, session_id: 'router-session' });
  process.exit(0);
});
