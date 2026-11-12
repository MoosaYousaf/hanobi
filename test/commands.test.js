const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const commands = require('../electron/commands');
const cli = require('../electron/providers/cli');
const { presets } = require('../electron/providers/catalog');
const { Files } = require('../electron/files');
const suggest = require('../electron/suggest');

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('commands: file commands and skills are listed; other models get them expanded, Claude Code runs its own', async () => {
  const home = tmp('orin-home-'), ws = tmp('orin-ws-'), saved = process.env.HOME;
  write(path.join(home, '.claude/commands/review.md'), '---\ndescription: Review code\n---\nHome review of $ARGUMENTS');
  write(path.join(ws, '.claude/commands/review.md'), '---\ndescription: Workspace review\nargument-hint: <path>\n---\nReview $ARGUMENTS carefully. First: $1');
  write(path.join(home, '.codex/prompts/plan.md'), 'Write a plan.');
  write(path.join(home, '.claude/skills/pdf/SKILL.md'), '---\nname: pdf\ndescription: Work with PDFs\n---\nUse pdftotext.');
  write(path.join(home, '.codex/skills/sheets/SKILL.md'), '---\ndescription: Sheets\n---\nUse csv.');
  process.env.HOME = home;
  try {
    const list = await commands.list(ws);
    assert.deepEqual(list.map(c => [c.kind, c.name, c.source]), [['command', 'review', 'Workspace'], ['command', 'plan', 'Codex'], ['skill', 'pdf', 'Claude'], ['skill', 'sheets', 'Codex']]);
    assert.equal(list[0].hint, '<path>');
    assert.equal(await commands.expand('/review src/a.js now', ws, 'codex'), 'Review src/a.js now carefully. First: src/a.js');
    assert.equal(await commands.expand('/plan for the API', ws, 'codex'), 'Write a plan.\n\nfor the API');
    // Claude Code knows Claude commands and skills; a Codex skill is still expanded for it.
    assert.equal(await commands.expand('/review src', ws, 'claude'), null);
    assert.equal(await commands.expand('/pdf', ws, 'claude'), null);
    assert.match(await commands.expand('/sheets totals', ws, 'claude'), /<skill name="sheets">\nUse csv.\n<\/skill>\n\ntotals$/);
    assert.match(await commands.expand('/pdf read it', ws, undefined), /Use pdftotext/);
    assert.equal(await commands.expand('/unknown x', ws, 'codex'), null);
    assert.equal(await commands.expand('not a command', ws, 'codex'), null);
  } finally { process.env.HOME = saved; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); }
});

test('mentions: workspace file search skips build folders; @paths become file parts read in place', async () => {
  const ws = tmp('orin-ws-'), out = tmp('orin-out-'), threads = tmp('orin-files-');
  try {
    write(path.join(ws, 'src/app.js'), 'console.log(1)');
    write(path.join(ws, 'src/my file.md'), '# Notes');
    write(path.join(ws, 'node_modules/x/app.js'), '');
    write(path.join(ws, 'logo.png'), Buffer.from([0x89, 0, 1]));
    write(path.join(out, 'secret.txt'), 'no');
    const found = await commands.searchFiles(ws, 'app');
    assert.deepEqual(found, ['src/app.js']);
    assert.ok((await commands.searchFiles(ws, '')).includes('src/'));
    const parts = commands.mentions(`Look at @src/app.js, @src/my\\ file.md and @src/ and @../${path.basename(out)}/secret.txt and @missing.js`, ws);
    assert.deepEqual(parts.map(p => [p.name, p.mention]), [['app.js', true], ['my file.md', true]]);
    // Mentioned files are read where they are; no text cache is written into the workspace.
    const texts = await new Files(threads).promptTexts([{ parts: [...parts, ...commands.mentions('@logo.png', ws)] }]);
    assert.equal(texts.get(path.join(ws, 'src/app.js')), 'console.log(1)');
    assert.equal(texts.get(path.join(ws, 'logo.png')), undefined);
    assert.equal(fs.existsSync(path.join(ws, 'src/.text')), false);
  } finally { for (const d of [ws, out, threads]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('suggestions: a CLI without its own suggestions answers one short request with no session or tools', async () => {
  const home = tmp('orin-home-'), bin = path.join(home, '.local/bin'), saved = process.env.HOME;
  // Prints the arguments and the stdin prompt back as the agent message.
  write(path.join(bin, 'codex'), `#!/usr/bin/env node
let input = ''; process.stdin.on('data', c => input += c).on('end', () => {
  const ok = process.argv.includes('--ephemeral') && process.argv.includes('read-only') && input.includes('Write up to 3 short messages');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ok ? '["Run the tests", "Ship it"]' : 'bad ' + process.argv.join(' ') } }));
});`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  process.env.HOME = home;
  try {
    cli.cliPath('codex', true);
    const prompt = suggest.prompt({ parts: [{ type: 'text', text: 'Fix the bug' }] }, { parts: [{ type: 'text', text: 'Fixed.' }] });
    const text = await cli.complete({ preset: presets.codex, model: '', prompt, signal: AbortSignal.timeout(10000) });
    assert.deepEqual(suggest.parse(text), ['Run the tests', 'Ship it']);
    assert.ok(cli.completeArgs('copilot', 'gpt-5-mini').includes('--deny-tool=shell'));
  } finally { process.env.HOME = saved; cli.cliPath('codex', true); fs.rmSync(home, { recursive: true, force: true }); }
});

test('helper requests to Claude Code load no MCP servers', () => {
  const args = cli.completeArgs('claude', 'claude-haiku-5-5');
  assert.ok(args.includes('--strict-mcp-config'));
});

test('suggested replies use Haiku on Claude connections and the thread model elsewhere', () => {
  assert.equal(suggest.model(presets['claude-code'], 'claude-opus-5-5'), 'claude-haiku-5-5');
  assert.equal(suggest.model(presets.anthropic, 'claude-opus-5-5'), 'claude-haiku-5-5');
  assert.equal(suggest.model(presets.codex, 'gpt-5.5'), 'gpt-5.5');
});
