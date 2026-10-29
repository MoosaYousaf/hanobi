// Starts the real app against a temporary data folder, drives the UI, and fails on any broken step.
// Set SMOKE_SHOTS=<folder> to save light and dark screenshots for visual review.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.HANOBI_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hanobi-smoke-'));
// Seed one conversation so message rendering is exercised.
const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hanobi-project-')));
const now = Date.now();
const text = t => ({ type: 'text', text: t });
fs.writeFileSync(path.join(process.env.HANOBI_USER_DATA, 'hanobi-data.json'), JSON.stringify({
  version: 2, workspaces: [{ id: 'w1', name: 'hanobi', path: folder }], connections: [],
  mcpServers: [{ id: 'notes', name: 'Notes', transport: 'stdio', command: 'node', args: [path.join(__dirname, '../test/fixtures/notes-server.cjs')], url: '', oauth: false, enabled: false }], modelCache: {}, preferences: { theme: 'system', systemPrompt: '', lastModel: null },
  threads: [{ id: 't1', workspaceId: 'w1', title: 'Parse the release notes', connectionId: 'claude-code', model: 'claude-opus-5-5', effort: 'high', mode: 'auto', sessionId: null, replay: false, createdAt: now, updatedAt: now, messages: [
    { id: 'm1', at: now, role: 'user', parts: [text('Find every breaking change in CHANGELOG.md and summarize them.')] },
    { id: 'm2', at: now, role: 'assistant', connectionId: 'claude-code', model: 'claude-opus-5-5', suggestions: ['Show the migration steps', 'Check the 1.x releases too'], parts: [
      { type: 'thinking', text: 'Read the changelog first, then group the entries by version.' },
      { type: 'tool', id: 'a', name: 'Read', input: { file_path: 'CHANGELOG.md' }, output: '## 2.0.0\n- Removed the legacy API', status: 'done' },
      { type: 'tool', id: 'b', name: 'Bash', input: { command: 'git log --oneline -5' }, output: 'fatal: not a git repository', status: 'error' },
      text('There are **two** breaking changes in `2.0.0`:\n\n1. The legacy API is removed.\n2. Config moved to `hanobi.json`.\n\n```js\nconst config = require(\'./hanobi.json\');\n```\n\n| Version | Change |\n| --- | --- |\n| 2.0.0 | Legacy API removed |')] }
  ] }]
}));
const { app, BrowserWindow, nativeTheme } = require('electron');
require('../electron/main.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(win, script, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await win.webContents.executeJavaScript(script)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const click = (win, selector) => win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing ${selector}'); el.click(); })()`);
const clickText = (win, selector, text) => win.webContents.executeJavaScript(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) throw new Error('Missing ${text}'); el.click(); })()`);
async function shot(win, name) {
  if (!process.env.SMOKE_SHOTS) return;
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await sleep(250);
    fs.writeFileSync(path.join(process.env.SMOKE_SHOTS, `${name}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  nativeTheme.themeSource = 'system';
}

app.whenReady().then(async () => {
  try {
    await sleep(300);
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    await until(win, `!!document.querySelector('.sidebar .ws-name')`, 'sidebar renders');
    await shot(win, '1-home');
    await clickText(win, '.thread-row', 'Parse the release notes');
    await until(win, `document.querySelectorAll('.msg').length === 2 && !!document.querySelector('.prose table')`, 'messages render');
    await clickText(win, '.suggestion', 'Show the migration steps');
    await until(win, `document.querySelector('.composer textarea, textarea').value === 'Show the migration steps'`, 'a suggestion fills the composer');
    await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.composer textarea, textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    win.webContents.send('run-state', { threadId: 't1', running: true });
    win.webContents.send('run-update', { threadId: 't1', parts: [text('Checking the docs connector.'), { type: 'tool', id: 'c', name: 'search', server: 'Notion', input: { query: 'release plan' }, status: 'pending' }] });
    win.webContents.send('approval', { id: 'p1', threadId: 't1', callId: 'c', server: 'Notion', tool: 'search', input: { query: 'release plan' } });
    win.webContents.send('question', { id: 'q1', threadId: 't1', callId: 'q', server: 'Claude Code', questions: [{ id: '0', header: 'Scope', question: 'Which releases should I cover?', multiSelect: false, options: [{ label: 'Only 2.x', description: 'The current major version.' }, { label: 'All releases', description: 'Includes 1.x.' }] }] });
    await until(win, `!!document.querySelector('.approval') && !!document.querySelector('.question') && !!document.querySelector('.send.stop')`, 'live reply, approval, and question render');
    await clickText(win, '.question-option', 'All releases');
    await until(win, `!document.querySelector('.question .btn.primary').disabled`, 'an option enables Send answers');
    await win.webContents.executeJavaScript(`document.querySelector('.question').scrollIntoView({ block: 'end' })`);
    await shot(win, '1b-thread');
    win.webContents.send('run-state', { threadId: 't1', running: false });
    await until(win, `!document.querySelector('.approval')`, 'live reply clears');
    await click(win, '.new-chat');
    await until(win, `!!document.querySelector('.composer textarea')`, 'composer renders');
    await click(win, '.chip');
    await until(win, `!!document.querySelector('.picker-pop .pick-route-label')`, 'model picker opens');
    await shot(win, '2-picker');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await click(win, '.sidebar-foot .foot-btn:last-child');
    await until(win, `!!document.querySelector('.settings .row')`, 'settings opens');
    await clickText(win, '.settings .btn', 'Add a provider');
    await until(win, `!!document.querySelector('.preset-grid')`, 'provider form opens');
    await shot(win, '3-settings');
    await clickText(win, '.settings-nav button', 'Connectors');
    await clickText(win, '.settings .row .btn', 'Connect');
    await until(win, `[...document.querySelectorAll('.settings .row .btn')].some(b => b.textContent === 'Disconnect') && document.querySelector('.settings .row').textContent.includes('1 tool')`, 'connector connects', 15000);
    await shot(win, '4a-connected');
    await clickText(win, '.settings .row .btn', 'Disconnect');
    await until(win, `document.querySelector('.settings .row .status').textContent === 'Off'`, 'connector disconnects');
    await clickText(win, '.settings .btn', 'Add a connector');
    await until(win, `document.querySelectorAll('.preset-grid .preset').length === 5`, 'connector presets');
    await shot(win, '4-connectors');
    await clickText(win, '.settings-nav button', 'General');
    await clickText(win, '.palette', 'Gemini style');
    await until(win, `document.documentElement.dataset.palette === 'gemini' && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() !== ''`, 'palette applies');
    await shot(win, '5-theme');
    await clickText(win, '.palette', 'Hanobi');
    await until(win, `document.documentElement.dataset.palette === 'hanobi'`, 'palette resets');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await click(win, '.settings-close');
    await clickText(win, '.thread-row', 'Parse the release notes');
    await until(win, `document.querySelectorAll('.msg').length === 2`, 'thread reopens');
    await until(win, `['Copy', 'Edit', 'Rewind', 'Branch'].every(t => document.querySelector('.msg.user [data-tip="' + t + '"]'))`, 'user message actions');
    await click(win, '.msg.user [data-tip="Rewind"]');
    await until(win, `!!document.querySelector('.rewind-menu') && document.querySelector('.rewind-note')?.textContent.includes('Git')`, 'rewind menu opens');
    await shot(win, '6-rewind');
    await clickText(win, '.rewind-menu button', 'Rewind conversation');
    await until(win, `!document.querySelector('.msg') && document.querySelector('.composer textarea, textarea').value.includes('breaking change')`, 'rewind empties the thread and refills the composer');
    await clickText(win, '.view-switch button', 'Chat');
    await until(win, `[...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'Chats') && document.querySelector('.new-chat').textContent.includes('New chat')`, 'chat view lists Chats');
    await clickText(win, '.side-action', 'New Project');
    await until(win, `!!document.querySelector('.dialog input')`, 'project name dialog opens');
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('.dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Launch plan'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click(win, '.dialog .btn.primary');
    await until(win, `document.querySelector('.project-head h1')?.textContent === 'Launch plan'`, 'project page opens');
    await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.project .system-prompt'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Write for customers.'); t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); t.blur(); })()`);
    await shot(win, '7-project');
    await clickText(win, '.project-head .btn', 'New chat');
    await until(win, `document.querySelector('.composer-note')?.textContent.includes('project’s documents') && !!document.querySelector('.crumb-ws') && document.querySelector('.crumb-ws').textContent === 'Launch plan'`, 'project chat opens in chat mode');
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.HANOBI_USER_DATA, 'hanobi-data.json'), 'utf8'));
    await sleep(600);
    const project = JSON.parse(fs.readFileSync(path.join(process.env.HANOBI_USER_DATA, 'hanobi-data.json'), 'utf8')).workspaces.find(w => w.kind === 'project');
    if (!project || project.instructions !== 'Write for customers.' || !fs.readFileSync(path.join(project.path, 'CLAUDE.md'), 'utf8').includes('Write for customers.')) throw new Error('Project instructions were not saved: ' + JSON.stringify(project || saved.workspaces));
    await clickText(win, '.view-switch button', 'Code');
    await until(win, `[...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'hanobi') && ![...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'Chats')`, 'code view lists folders only');
    if (errors.length) throw new Error('Console errors:\n' + errors.join('\n'));
    process.stdout.write('Smoke passed: home, saved messages, live reply with approval, new conversation, model picker, settings, connector connect and disconnect, connector presets, theme palettes, rewind, suggested replies, questions, chat and projects.\n');
    app.exit(0);
  } catch (error) { process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); }
});
