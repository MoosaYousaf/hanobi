#!/usr/bin/env node
// A stand-in for the speech helper. FAKE_SPEECH picks the behavior: talk (default), deny, abort.
const mode = process.env.FAKE_SPEECH || 'talk';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
if (mode === 'abort') process.kill(process.pid, 'SIGABRT');
else if (mode === 'deny') { out({ type: 'error', message: 'Orin cannot use speech recognition.' }); process.exit(1); }
else {
  out({ type: 'ready', locale: process.argv[2] });
  out({ type: 'level', value: 0.4 });
  out({ type: 'partial', text: `hello from ${process.argv[2]}` });
  let input = '';
  process.stdin.on('data', chunk => {
    input += chunk;
    if (input.includes('stop\n')) { out({ type: 'final', text: ` Hello from ${process.argv[2]}. ` }); process.exit(0); }
    if (input.includes('cancel\n')) process.exit(0);
  });
}
