#!/usr/bin/env node
// Acts as llama-server: /health answers 503 for 300 ms (the model "loads"), then 200; chat completions stream a
// fixed reply that names the model alias and the arguments it got. FAKE_LLAMA_FAIL=1 exits with an error instead.
const http = require('node:http');
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
if (args.includes('--version')) { console.log('version: fake-llama (test)'); process.exit(0); }
if (process.env.FAKE_LLAMA_FAIL) { console.error('error: failed to load model: bad magic'); process.exit(1); }
if (!process.env.FAKE_LLAMA_NO_MODEL_CHECK && !require('node:fs').existsSync(arg('--model'))) { console.error('error: model file missing'); process.exit(1); }
const started = Date.now();
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.statusCode = Date.now() - started > 300 ? 200 : 503; return res.end('{}'); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end(); }
    const request = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = delta => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, ...delta }] })}\n\n`);
    chunk({ delta: { content: `local ${arg('--alias')} ctx=${arg('--ctx-size')} parallel=${arg('--parallel')} ` } });
    chunk({ delta: { content: `model=${request.model} tools=${request.tools ? request.tools.length : 0}` }, finish_reason: 'stop' });
    res.end('data: [DONE]\n\n');
  });
});
server.listen(Number(arg('--port')), arg('--host'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
