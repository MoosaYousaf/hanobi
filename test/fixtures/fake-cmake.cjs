#!/usr/bin/env node
// Acts as cmake. Configure (-S) logs its arguments. Build (--build) prints ninja-style progress and puts a fake
// llama-server in <build>/bin. FAKE_CMAKE_FAIL=1 fails the build with a compiler error line.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = process.env.FAKE_CMAKE_LOG;
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), sourceFiles: args.includes('-S') ? fs.readdirSync(args[args.indexOf('-S') + 1]) : null }) + '\n');
if (args.includes('--build')) {
  for (let i = 1; i <= 4; i++) process.stdout.write(`[${i}/4] Building CXX object x${i}.o\n`);
  if (process.env.FAKE_CMAKE_FAIL) { process.stderr.write('/src/llama.cpp:1:1: error: unknown type name\n'); process.exit(1); }
  const bin = path.join(args[args.indexOf('--build') + 1], 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fake-llama-server.cjs'), path.join(bin, 'llama-server'));
  fs.chmodSync(path.join(bin, 'llama-server'), 0o755);
}
