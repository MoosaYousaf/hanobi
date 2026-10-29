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
// A file part whose file exists in the thread's folder, the way files:attach and write_file leave it.
const fileSeed = (kind, name, body) => {
  const dir = path.join(process.env.HANOBI_USER_DATA, 'Files', 't2', kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
  return { type: 'file', name, path: path.join(dir, name), size: Buffer.byteLength(body), mediaType: name.endsWith('.csv') ? 'text/csv' : 'text/plain' };
};
fs.writeFileSync(path.join(process.env.HANOBI_USER_DATA, 'hanobi-data.json'), JSON.stringify({
  version: 2, workspaces: [{ id: 'w1', name: 'hanobi', path: folder }], connections: [],
  mcpServers: [{ id: 'notes', name: 'Notes', transport: 'stdio', command: 'node', args: [path.join(__dirname, '../test/fixtures/notes-server.cjs')], url: '', oauth: false, enabled: false }], modelCache: {}, preferences: { theme: 'system', systemPrompt: '', lastModel: null },
  threads: [{ id: 't1', workspaceId: 'w1', title: 'Parse the release notes', connectionId: 'claude-code', model: 'claude-opus-5-5', effort: 'high', mode: 'auto', sessionId: null, replay: false, createdAt: now, updatedAt: now, messages: [
    { id: 'm1', at: now, role: 'user', parts: [text('Find every breaking change in CHANGELOG.md and summarize them.')] },
    { id: 'm2', at: now, role: 'assistant', connectionId: 'claude-code', model: 'claude-opus-5-5', usage: { used: 45200, window: 1000000 }, suggestions: ['Show the migration steps', 'Check the 1.x releases too'], parts: [
      { type: 'thinking', text: 'Read the changelog first, then group the entries by version.' },
      { type: 'tool', id: 'a', name: 'Read', input: { file_path: 'CHANGELOG.md' }, output: '## 2.0.0\n- Removed the legacy API', status: 'done' },
      { type: 'tool', id: 'b', name: 'Bash', input: { command: 'git log --oneline -5' }, output: 'fatal: not a git repository', status: 'error' },
      text('There are **two** breaking changes in `2.0.0`:\n\n1. The legacy API is removed.\n2. Config moved to `hanobi.json`.\n\n```js\nconst config = require(\'./hanobi.json\');\n```\n\n| Version | Change |\n| --- | --- |\n| 2.0.0 | Legacy API removed |')] }
  ] }, { id: 't2', workspaceId: 'w1', title: 'Quarterly table', connectionId: 'claude-code', model: 'claude-opus-5-5', effort: 'high', mode: 'auto', sessionId: null, replay: false, createdAt: now - 60000, updatedAt: now - 60000, messages: [
    { id: 'm3', at: now, role: 'user', parts: [fileSeed('in', 'brief.txt', 'Q3 figures'), text('Make a table of the totals.')] },
    { id: 'm4', at: now, role: 'assistant', connectionId: 'claude-code', model: 'claude-opus-5-5', parts: [
      { type: 'tool', id: 'w', name: 'Write', input: { file_path: path.join(folder, 'report.md'), content: '# Report' }, output: 'File created', status: 'done' },
      fileSeed('out', 'totals.csv', 'region,total\nNorth,12\n'),
      text('# Quarterly totals\n\n```csv totals.csv\nregion,total\nNorth,12\nSouth,9\n```\n\n```python\nprint("done")\n```\n\n```html\n<p id="out">waiting</p><script>document.getElementById("out").textContent = "ran " + (typeof require) + " " + (typeof window.hanobi)</script>\n```')] }
  ] }]
}));
// The workspace is a Git repository with a GitHub origin. A fake gh answers with one pull request.
const { execFileSync } = require('node:child_process');
const gitIn = (...args) => execFileSync('git', args, { cwd: folder });
gitIn('init', '-q', '-b', 'feature/parser'); gitIn('config', 'user.email', 'smoke@example.com'); gitIn('config', 'user.name', 'Smoke');
gitIn('remote', 'add', 'origin', 'https://github.com/example/hanobi.git');
fs.writeFileSync(path.join(folder, 'CHANGELOG.md'), '## 2.0.0\n'); gitIn('add', '.'); gitIn('commit', '-qm', 'init');
fs.writeFileSync(path.join(folder, 'notes.md'), 'draft\n');
const ghBin = fs.mkdtempSync(path.join(os.tmpdir(), 'hanobi-gh-'));
fs.copyFileSync(path.join(__dirname, '../test/fixtures/fake-gh.cjs'), path.join(ghBin, 'gh')); fs.chmodSync(path.join(ghBin, 'gh'), 0o755);
process.env.PATH = `${ghBin}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_GH_LOG = path.join(ghBin, 'log'); process.env.FAKE_GH_STATE = path.join(ghBin, 'state.json');
fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify({ pr: { number: 12, title: 'Parse breaking changes from the changelog', url: 'https://github.com/example/hanobi/pull/12', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', headRefName: 'feature/parser', baseRefName: 'main', author: { login: 'me' }, updatedAt: '2026-10-29T00:00:00Z' } }));
// Fixed plan limits: the session window is fine, the week is near its cap.
const inHours = h => Date.now() + h * 3600 * 1000;
process.env.HANOBI_LIMITS_FIXTURE = JSON.stringify({ claude: { plan: 'Claude Pro', windows: [{ id: 'five_hour', label: 'Session (5 hours)', used: 54, resetsAt: inHours(2) }, { id: 'seven_day', label: 'Week', used: 86, resetsAt: inHours(50) }], note: '' } });
// A fake speech helper streams words without a microphone.
process.env.HANOBI_SPEECH_HELPER = path.join(__dirname, '../test/fixtures/fake-speech.cjs');
const { app, BrowserWindow, nativeTheme, dialog, systemPreferences, clipboard } = require('electron');
// The microphone first answers "denied", so voice input shows its permission message without a macOS prompt.
let microphone = 'denied';
systemPreferences.getMediaAccessStatus = () => microphone;
systemPreferences.askForMediaAccess = async () => false;
// Save dialogs answer with a fixed path, so downloads run without a person.
let saveTarget = null;
dialog.showSaveDialog = async () => ({ canceled: !saveTarget, filePath: saveTarget });
require('../electron/main.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(win, script, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await win.webContents.executeJavaScript(script)) return; await sleep(100); }
  const detail = await win.webContents.executeJavaScript(`JSON.stringify(window.__pick || null)`).catch(() => null);
  throw new Error(`Timed out: ${label}${detail && detail !== "null" ? ` ${detail}` : ""}`);
}
// Errors thrown in the page lose their message, so a missing element is reported from here.
const click = async (win, selector) => { if (!await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`)) throw new Error(`Missing ${selector}`); };
const clickText = async (win, selector, text) => { if (!await win.webContents.executeJavaScript(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`)) throw new Error(`Missing ${text} in ${selector}`); };
async function shot(win, name) {
  if (!process.env.SMOKE_SHOTS) return;
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await sleep(250);
    fs.writeFileSync(path.join(process.env.SMOKE_SHOTS, `${name}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  nativeTheme.themeSource = 'system';
}

const errors = [];
app.whenReady().then(async () => {
  try {
    await sleep(300);
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    await until(win, `!!document.querySelector('.sidebar .ws-name')`, 'sidebar renders');
    await shot(win, '1-home');
    await clickText(win, '.thread-row', 'Parse the release notes');
    await until(win, `document.querySelectorAll('.msg').length === 2 && !!document.querySelector('.prose table')`, 'messages render');
    await until(win, `document.querySelector('.composer-row .usage-ring')?.getAttribute('aria-label') === 'Session (5 hours): 54% used, 46% left'`, 'usage ring shows the plan session');
    await until(win, `(() => { const card = document.querySelector('.usage-card')?.textContent || ''; return card.includes('Claude Pro') && card.includes('Week86% used') && card.includes('14% left') && card.includes('Context: 45.2k of 1M tokens (5%)'); })()`, 'usage card shows windows, what is left, and the context');
    await until(win, `document.querySelector('.composer-row .usage-ring').classList.contains('high') && document.querySelector('.limit-warn')?.textContent === 'Week: 14% left'`, 'a window near its cap warns');
    await until(win, `/near the usage limit/.test(document.querySelector('.toast')?.textContent || '')`, 'a toast warns once near the cap');
    await win.webContents.executeJavaScript(`document.querySelector('.usage-card').style.display = 'flex'`);
    await shot(win, '1a-usage');
    await click(win, '.composer-row [aria-label="Access mode"]');
    await until(win, `(() => { const pop = document.querySelector('.option-pop'); if (!pop) return false; const probe = document.body.appendChild(Object.assign(document.createElement('div'), { style: 'background: var(--raised)' })); const raised = getComputedStyle(probe).backgroundColor; probe.remove(); const r = pop.getBoundingClientRect(), s = pop.querySelector('.pick-scroll'); window.__pick = { n: pop.querySelectorAll('.option-item').length, sh: s.scrollHeight, ch: s.clientHeight, top: r.top, bg: getComputedStyle(pop).backgroundColor, raised }; return window.__pick.n >= 4 && s.scrollHeight <= s.clientHeight + 1 && r.top >= 0 && window.__pick.bg === raised; })()`, 'access picker is themed and shows every mode without scrolling');
    await shot(win, '1a-access');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await click(win, '.composer-row [aria-label="Effort"]');
    await until(win, `[...document.querySelectorAll('.option-pop .option-item')].some(b => b.textContent === 'High' && b.classList.contains('selected'))`, 'effort picker marks the current effort');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await win.webContents.executeJavaScript(`document.querySelector('.usage-card').style.display = ''`);
    await clickText(win, '.suggestion', 'Show the migration steps');
    await until(win, `document.querySelector('.composer textarea, textarea').value === 'Show the migration steps'`, 'a suggestion fills the composer');
    await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.composer textarea, textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    win.webContents.send('run-state', { threadId: 't1', running: true, startedAt: Date.now() - 65000 });
    win.webContents.send('run-update', { threadId: 't1', parts: [text('Checking the docs connector.'), { type: 'tool', id: 'c', name: 'search', server: 'Notion', input: { query: 'release plan' }, status: 'pending' }] });
    win.webContents.send('approval', { id: 'p1', threadId: 't1', callId: 'c', server: 'Notion', tool: 'search', input: { query: 'release plan' } });
    win.webContents.send('question', { id: 'q1', threadId: 't1', callId: 'q', server: 'Claude Code', questions: [{ id: '0', header: 'Scope', question: 'Which releases should I cover?', multiSelect: false, options: [{ label: 'Only 2.x', description: 'The current major version.' }, { label: 'All releases', description: 'Includes 1.x.' }] }] });
    await until(win, `!!document.querySelector('.approval') && !!document.querySelector('.question') && !!document.querySelector('.send.stop')`, 'live reply, approval, and question render');
    await clickText(win, '.question-option', 'All releases');
    await until(win, `!document.querySelector('.question .btn.primary').disabled`, 'an option enables Send answers');
    await win.webContents.executeJavaScript(`document.querySelector('.question').scrollIntoView({ block: 'end' })`);
    await shot(win, '1b-thread');
    // The status line counts the time and opens the background work: thinking and tool calls.
    win.webContents.send('run-update', { threadId: 't1', parts: [{ type: 'thinking', text: 'The connector may hold the plan.' }, text('Checking the docs connector.'), { type: 'tool', id: 'c', name: 'search', server: 'Notion', input: { query: 'release plan' }, status: 'pending' }] });
    await until(win, `/^1m 0[5-9]s$/.test(document.querySelector('.activity-time')?.textContent) && document.querySelector('.activity-head .working')?.textContent === 'Waiting for you'`, 'the status line shows the elapsed time');
    await click(win, '.activity-head');
    await until(win, `document.querySelector('.activity-thinking')?.textContent === 'The connector may hold the plan.' && document.querySelector('.activity-tool code')?.textContent === 'release plan'`, 'the status line opens the thinking and tool calls');
    await win.webContents.executeJavaScript(`document.querySelector('.activity').scrollIntoView({ block: 'center' })`);
    await shot(win, '1b-activity');
    win.webContents.send('run-state', { threadId: 't1', running: false });
    await until(win, `!document.querySelector('.approval')`, 'live reply clears');
    await click(win, '.topbar [title="Changes"]');
    await until(win, `document.querySelector('.branch-btn')?.textContent === 'feature/parser' && document.querySelector('.pr-card .pr-title')?.textContent.includes('#12')`, 'Changes panel shows the branch and its pull request');
    await until(win, `document.querySelector('.pr-meta')?.textContent.includes('Changes requested') && document.querySelector('.pr-checks')?.dataset.tip === 'Checks: 2 passed, 1 failed, 1 pending'`, 'pull request review and checks');
    await until(win, `document.querySelector('.pr-row')?.textContent.includes('Other work') && !!document.querySelector('.git-path[title="notes.md"]')`, 'open pull requests and changed files');
    await shot(win, '1c-changes');
    await click(win, '.branch-btn');
    await until(win, `[...document.querySelectorAll('.menu-item')].some(b => b.textContent === 'New branch…') && [...document.querySelectorAll('.menu-item')].some(b => b.textContent === 'feature/parser' && b.disabled)`, 'branch menu lists branches');
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await click(win, '.topbar [title="Changes"]');
    fs.writeFileSync(path.join(folder, 'report.md'), '# Report\n');
    await clickText(win, '.thread-row', 'Quarterly table');
    await until(win, `[...document.querySelectorAll('.code-lang')].map(e => e.textContent).join() === 'totals.csv,Python,HTML'`, 'code blocks show a file name and a language');
    await until(win, `[...document.querySelectorAll('.file-card .file-name')].map(e => e.textContent).join() === 'brief.txt,report.md,totals.csv'`, 'file cards for an attachment, a written file, and a made file');
    await clickText(win, '.code-btn', 'Preview');
    await until(win, `[...document.querySelectorAll('.snippet-table td')].map(e => e.textContent).join() === 'North,12,South,9'`, 'CSV preview shows a table');
    await shot(win, '1d-files');
    // Copy puts the exact snippet on the clipboard (through main) and says so.
    clipboard.writeText('');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.code-block')[1].querySelector('[aria-label="Copy code"]').click()`);
    await until(win, `document.querySelector('.toast')?.textContent === 'Code copied to the clipboard'`, 'copy confirms with a toast');
    if (clipboard.readText() !== 'print("done")') throw new Error(`Copy wrote ${JSON.stringify(clipboard.readText())}`);
    // Run opens the HTML snippet with scripts on, in its own window without Node.js or the Hanobi bridge.
    const windowCount = BrowserWindow.getAllWindows().length;
    await clickText(win, '.code-btn', 'Run');
    let runWin;
    for (let i = 0; i < 50 && !runWin; i++) { await sleep(100); runWin = BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith('Run: ')); }
    if (!runWin || BrowserWindow.getAllWindows().length !== windowCount + 1) throw new Error('Timed out: Run opens a window');
    await until(runWin, `document.getElementById('out')?.textContent === 'ran undefined undefined'`, 'the snippet script runs without require or the Hanobi bridge');
    const permission = await Promise.race([runWin.webContents.executeJavaScript(`navigator.permissions.query({ name: 'geolocation' }).then(p => p.state)`), sleep(3000).then(() => 'timeout')]);
    if (permission !== 'denied') throw new Error(`Run window permissions are not denied: ${permission}`);
    runWin.destroy();
    for (const extension of ['pdf', 'docx']) {
      saveTarget = path.join(ghBin, `reply.${extension}`);
      await click(win, '.msg.assistant .msg-actions [data-tip="Download"]');
      await until(win, `[...document.querySelectorAll('.menu-item')].some(b => b.textContent.includes('(.${extension})'))`, 'reply download menu');
      await clickText(win, '.menu-item', `(.${extension})`);
      const end = Date.now() + 10000;
      while (!fs.existsSync(saveTarget) && Date.now() < end) await sleep(100);
      if (!fs.existsSync(saveTarget)) throw new Error(`Timed out: reply saves as ${extension}`);
    }
    await sleep(300);
    if (!fs.readFileSync(path.join(ghBin, 'reply.pdf')).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('reply.pdf is not a PDF');
    if (!/Quarterly totals[\s\S]*North/.test(execFileSync('textutil', ['-convert', 'txt', '-stdout', path.join(ghBin, 'reply.docx')], { encoding: 'utf8' }))) throw new Error('reply.docx text is wrong');
    saveTarget = null;
    await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.composer-row .icon-btn.mic'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })); })()`);
    await until(win, `(document.querySelector('.toast')?.textContent || '').includes('Privacy & Security → Microphone') && !document.querySelector('.icon-btn.mic.live')`, 'voice input explains a denied microphone');
    microphone = 'granted';
    await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Note:'); t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.composer-row .icon-btn.mic').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); document.querySelector('.composer-row .icon-btn.mic').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })); })()`);
    await until(win, `!!document.querySelector('.icon-btn.mic.live') && document.querySelector('.composer textarea').value === 'Note: hello from en-US' && /words show as you speak/.test(document.querySelector('.voice-status')?.textContent)`, 'spoken words show in the composer while listening');
    await shot(win, '11-voice');
    await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.composer-row .icon-btn.mic.live'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })); })()`);
    await until(win, `!document.querySelector('.icon-btn.mic.live') && !document.querySelector('.voice-status') && document.querySelector('.composer textarea').value === 'Note: Hello from en-US.'`, 'the final text replaces the partial text');
    await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await clickText(win, '.thread-row', 'Parse the release notes');
    await click(win, '.new-chat');
    await until(win, `!!document.querySelector('.composer textarea')`, 'composer renders');
    await click(win, '.chip[title="Choose a model"]');
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
    await until(win, `[...document.querySelectorAll('.settings .shortcut-row')].map(r => r.textContent).join('|').match(/Show Hanobi from any app.*⌥ Space.*\\|Hanobi 0\\.\\d+\\.\\d+.*Check now/) !== null`, 'desktop settings show the shortcut and the version');
    await until(win, `document.querySelector('.voice-language select')?.value === 'en' && !document.querySelector('.settings .hint.warn')`, 'voice settings show the language and a ready helper');
    await clickText(win, '.settings .shortcut-row .btn', 'Turn off');
    await until(win, `[...document.querySelectorAll('.settings .shortcut-row .btn.shortcut')][0]?.textContent === 'Off'`, 'the shortcut turns off');
    await clickText(win, '.settings .shortcut-row .btn', 'Use ⌥ Space');
    await until(win, `[...document.querySelectorAll('.settings .shortcut-row .btn.shortcut')][0]?.textContent.includes('Space')`, 'the shortcut turns on');
    await clickText(win, '.palette', 'Hanobi');
    await until(win, `document.documentElement.dataset.palette === 'hanobi'`, 'palette resets');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await click(win, '.settings-close');
    await clickText(win, '.thread-row', 'Parse the release notes');
    await until(win, `document.querySelectorAll('.msg').length === 2`, 'thread reopens');
    await until(win, `['Copy', 'Edit', 'Rewind', 'Branch'].every(t => document.querySelector('.msg.user [data-tip="' + t + '"]'))`, 'user message actions');
    // Edit opens a full-width box that fits the text, then Escape puts the bubble back.
    await click(win, '.msg.user [data-tip="Edit"]');
    await until(win, `(() => { const t = document.querySelector('.edit-box textarea'); return t && t.scrollHeight <= t.clientHeight + 2 && t.getBoundingClientRect().width >= document.querySelector('.msg.user').getBoundingClientRect().width - 1; })()`, 'edit box fits its text and the column');
    await shot(win, '5b-edit');
    await win.webContents.executeJavaScript(`document.querySelector('.edit-box textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(win, `!document.querySelector('.edit-box') && !!document.querySelector('.user-bubble')`, 'Escape leaves edit');
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
    await until(win, `!document.querySelector('.composer-row [aria-label="Access mode"]') && !!document.querySelector('.crumb-ws') && document.querySelector('.crumb-ws').textContent === 'Launch plan'`, 'project chat opens in chat mode');
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.HANOBI_USER_DATA, 'hanobi-data.json'), 'utf8'));
    await sleep(600);
    const project = JSON.parse(fs.readFileSync(path.join(process.env.HANOBI_USER_DATA, 'hanobi-data.json'), 'utf8')).workspaces.find(w => w.kind === 'project');
    if (!project || project.instructions !== 'Write for customers.' || !fs.readFileSync(path.join(project.path, 'CLAUDE.md'), 'utf8').includes('Write for customers.')) throw new Error('Project instructions were not saved: ' + JSON.stringify(project || saved.workspaces));
    await clickText(win, '.view-switch button', 'Code');
    await until(win, `[...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'hanobi') && ![...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'Chats')`, 'code view lists folders only');
    await clickText(win, '.thread-row', 'Parse the release notes');
    await until(win, `document.querySelectorAll('.pane').length === 1`, 'thread opens in one pane');
    await click(win, '[title="New split pane (⌘D)"]');
    await until(win, `document.querySelectorAll('.pane').length === 2 && !!document.querySelector('.pane-divider') && !!document.querySelector('.pane.active')`, 'split pane opens');
    const before = await win.webContents.executeJavaScript(`document.querySelector('.pane').getBoundingClientRect().width`);
    await win.webContents.executeJavaScript(`(() => {
      const d = document.querySelector('.pane-divider').getBoundingClientRect();
      const x = d.left + d.width / 2, y = d.top + 200;
      document.querySelector('.pane-divider').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 120, clientY: y }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + 120, clientY: y }));
    })()`);
    await until(win, `Math.abs(document.querySelector('.pane').getBoundingClientRect().width - ${before} - 120) < 4`, 'divider resizes panes');
    await shot(win, '8-split');
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.thread-row')].find(r => r.textContent.includes('Parse the release notes')).querySelector('.thread-more').click()`);
    await until(win, `['Rename', 'Open in split pane', 'Pin to top', 'Move to workspace', 'Delete'].every(t => [...document.querySelectorAll('.menu .menu-item')].some(b => b.textContent === t))`, 'thread menu opens');
    await shot(win, '9-menu');
    await clickText(win, '.menu .menu-item', 'Pin to top');
    await until(win, `[...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'Pinned')`, 'pinned group shows');
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.thread-row')].find(r => r.textContent.includes('Parse the release notes')).querySelector('.thread-more').click()`);
    await clickText(win, '.menu .menu-item', 'Delete');
    await until(win, `!!document.querySelector('.dialog .btn.danger') && document.querySelector('.dialog-title').textContent.includes('Parse the release notes')`, 'delete dialog matches the app');
    await shot(win, '9b-delete');
    await clickText(win, '.dialog .btn', 'Cancel');
    await until(win, `!document.querySelector('.dialog')`, 'delete dialog cancels');
    await click(win, '.pane.active [title="Focus mode (⇧⌘F)"]');
    await until(win, `!!document.querySelector('.app.focus') && !document.querySelector('.sidebar') && document.querySelectorAll('.pane').length === 1`, 'focus mode fills the window');
    await shot(win, '10-focus');
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(win, `!document.querySelector('.app.focus') && !!document.querySelector('.sidebar') && document.querySelectorAll('.pane').length === 2`, 'Escape leaves focus mode and the panes return');
    // Drag the last conversation of a list above the first one.
    const order = () => win.webContents.executeJavaScript(`[...[...document.querySelectorAll('.ws')].find(w => w.querySelectorAll('.thread-row').length > 1).querySelectorAll('.thread-row .thread-title')].map(t => t.textContent)`);
    const listed = await order();
    await win.webContents.executeJavaScript(`(() => {
      const rows = [...[...document.querySelectorAll('.ws')].find(w => w.querySelectorAll('.thread-row').length > 1).querySelectorAll('.thread-row')];
      const source = rows.at(-1), target = rows[0], data = new DataTransfer(), y = target.getBoundingClientRect().top + 2;
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: y }));
      return new Promise(r => setTimeout(() => { target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientY: y })); source.dispatchEvent(new DragEvent('dragend', { bubbles: true })); r(); }, 50));
    })()`);
    await until(win, `(${JSON.stringify(listed)}).at(-1) === [...[...document.querySelectorAll('.ws')].find(w => w.querySelectorAll('.thread-row').length > 1).querySelectorAll('.thread-row .thread-title')][0].textContent`, 'dragging a conversation reorders the list');
    if (errors.length) throw new Error('Console errors:\n' + errors.join('\n'));
    process.stdout.write('Smoke passed: home, saved messages, live reply with approval, elapsed time and background work, themed access and effort pickers, new conversation, model picker, settings, connector connect and disconnect, connector presets, theme palettes, rewind, suggested replies, questions, chat and projects, split panes, thread menu, delete dialog, focus mode, usage ring, drag to reorder, branches and pull requests, code snippet bar, copy, preview, and isolated Run, message edit, file cards, reply export to PDF and Word, desktop settings, voice input with live words, plan usage limits.\n');
    app.exit(0);
  } catch (error) {
    if (errors.length) console.error('Console errors:\n' + errors.join('\n')); process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); }
});
