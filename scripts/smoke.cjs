// Starts the real app against a temporary data folder, drives the UI, and fails on any broken step.
// Set SMOKE_SHOTS=<folder> to save light and dark screenshots for visual review.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.ORIN_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'orin-smoke-'));
// Seed one conversation so message rendering is exercised.
const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orin-project-')));
const now = Date.now();
const text = t => ({ type: 'text', text: t });
// A file part whose file exists in the thread's folder, the way files:attach and write_file leave it.
const fileSeed = (kind, name, body) => {
  const dir = path.join(process.env.ORIN_USER_DATA, 'Files', 't2', kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
  return { type: 'file', name, path: path.join(dir, name), size: Buffer.byteLength(body), mediaType: name.endsWith('.csv') ? 'text/csv' : 'text/plain' };
};
fs.writeFileSync(path.join(process.env.ORIN_USER_DATA, 'orin-data.json'), JSON.stringify({
  version: 2, workspaces: [{ id: 'w1', name: 'orin', path: folder }], connections: [],
  mcpServers: [{ id: 'notes', name: 'Notes', transport: 'stdio', command: 'node', args: [path.join(__dirname, '../test/fixtures/notes-server.cjs')], url: '', oauth: false, enabled: false }], modelCache: {}, preferences: { theme: 'system', systemPrompt: '', lastModel: null },
  threads: [{ id: 't1', workspaceId: 'w1', title: 'Parse the release notes', connectionId: 'claude-code', model: 'claude-opus-5-5', effort: 'high', mode: 'auto', sessionId: null, replay: false, createdAt: now, updatedAt: now, messages: [
    { id: 'm1', at: now, role: 'user', parts: [text('Find every breaking change in CHANGELOG.md and summarize them.')] },
    { id: 'm2', at: now, role: 'assistant', connectionId: 'claude-code', model: 'claude-opus-5-5', usage: { used: 45200, window: 1000000 }, suggestions: ['Show the migration steps', 'Check the 1.x releases too'], parts: [
      { type: 'thinking', text: 'Read the changelog first, then group the entries by version.' },
      { type: 'tool', id: 'a', name: 'Read', input: { file_path: 'CHANGELOG.md' }, output: '## 2.0.0\n- Removed the legacy API', status: 'done' },
      { type: 'tool', id: 'b', name: 'Bash', input: { command: 'git log --oneline -5' }, output: 'fatal: not a git repository', status: 'error' },
      text('There are **two** breaking changes in `2.0.0`:\n\n1. The legacy API is removed.\n2. Config moved to `orin.json`.\n\n```js\nconst config = require(\'./orin.json\');\n```\n\n| Version | Change |\n| --- | --- |\n| 2.0.0 | Legacy API removed |')] }
  ] }, { id: 't2', workspaceId: 'w1', title: 'Quarterly table', connectionId: 'claude-code', model: 'claude-opus-5-5', effort: 'high', mode: 'auto', sessionId: null, replay: false, createdAt: now - 60000, updatedAt: now - 60000, messages: [
    { id: 'm3', at: now, role: 'user', parts: [fileSeed('in', 'brief.txt', 'Q3 figures'), text('Make a table of the totals.')] },
    { id: 'm4', at: now, role: 'assistant', connectionId: 'claude-code', model: 'claude-opus-5-5', parts: [
      { type: 'tool', id: 'w', name: 'Write', input: { file_path: path.join(folder, 'report.md'), content: '# Report' }, output: 'File created', status: 'done' },
      fileSeed('out', 'totals.csv', 'region,total\nNorth,12\n'),
      text('# Quarterly totals\n\n```csv totals.csv\nregion,total\nNorth,12\nSouth,9\n```\n\n```python\nprint("done")\n```\n\n```html\n<p id="out">waiting</p><script>document.getElementById("out").textContent = "ran " + (typeof require) + " " + (typeof window.orin)</script>\n```\n\n```mermaid\nflowchart LR\n  Plan --> Build --> Ship\n```')] }
  ] }]
}));
// The workspace is a Git repository with a GitHub origin. A fake gh answers with one pull request.
const { execFileSync } = require('node:child_process');
const gitIn = (...args) => execFileSync('git', args, { cwd: folder });
gitIn('init', '-q', '-b', 'feature/parser'); gitIn('config', 'user.email', 'smoke@example.com'); gitIn('config', 'user.name', 'Smoke');
gitIn('remote', 'add', 'origin', 'https://github.com/example/orin.git');
fs.writeFileSync(path.join(folder, 'CHANGELOG.md'), '## 2.0.0\n'); gitIn('add', '.'); gitIn('commit', '-qm', 'init');
fs.writeFileSync(path.join(folder, 'notes.md'), 'draft\n');
const ghBin = fs.mkdtempSync(path.join(os.tmpdir(), 'orin-gh-'));
fs.copyFileSync(path.join(__dirname, '../test/fixtures/fake-gh.cjs'), path.join(ghBin, 'gh')); fs.chmodSync(path.join(ghBin, 'gh'), 0o755);
process.env.PATH = `${ghBin}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_GH_LOG = path.join(ghBin, 'log'); process.env.FAKE_GH_STATE = path.join(ghBin, 'state.json');
fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify({ pr: { number: 12, title: 'Parse breaking changes from the changelog', url: 'https://github.com/example/orin/pull/12', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', headRefName: 'feature/parser', baseRefName: 'main', author: { login: 'me' }, updatedAt: '2026-10-29T00:00:00Z' } }));
// Fixed plan limits: the session window is fine, the week is near its cap.
const inHours = h => Date.now() + h * 3600 * 1000;
process.env.ORIN_LIMITS_FIXTURE = JSON.stringify({ claude: { plan: 'Claude Pro', windows: [{ id: 'five_hour', label: 'Session (5 hours)', used: 54, resetsAt: inHours(2) }, { id: 'seven_day', label: 'Week', used: 86, resetsAt: inHours(50) }], note: '' } });
// A fake speech helper streams words without a microphone.
process.env.ORIN_SPEECH_HELPER = path.join(__dirname, '../test/fixtures/fake-speech.cjs');
// The Terminal page runs tmux on its own server, so the user's tmux sessions stay untouched.
process.env.ORIN_TMUX_SOCKET = `orin-smoke-${process.pid}`;
const stopTmux = () => {
  const tmux = require('../electron/terminal.js').tmuxPath();
  if (tmux) try { require('node:child_process').execFileSync(tmux, ['-L', process.env.ORIN_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch {}
  fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, process.env.ORIN_TMUX_SOCKET), { force: true });
};
const { app, BrowserWindow, nativeTheme, dialog, systemPreferences, clipboard } = require('electron');
// The microphone first answers "denied", so voice input shows its permission message without a macOS prompt.
let microphone = 'denied';
systemPreferences.getMediaAccessStatus = () => microphone;
systemPreferences.askForMediaAccess = async () => false;
// Save dialogs answer with a fixed path, so downloads run without a person.
let saveTarget = null;
dialog.showSaveDialog = async () => ({ canceled: !saveTarget, filePath: saveTarget });
// Local models: a fake Hugging Face answers search, file lists, and downloads.
let hfServer;
const hfReady = require('../test/fixtures/fake-hf.cjs').server().then(({ srv, base }) => { hfServer = srv; process.env.ORIN_HF_BASE = base; });
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
    await sleep(500); // theme-dependent drawings (Mermaid) redraw after a short delay
    fs.writeFileSync(path.join(process.env.SMOKE_SHOTS, `${name}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  nativeTheme.themeSource = 'system';
}

const errors = [];
app.whenReady().then(async () => {
  try {
    await hfReady;
    await sleep(300);
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    await until(win, `!!document.querySelector('.sidebar .ws-name')`, 'sidebar renders');
    await until(win, `document.querySelector('.home p')?.textContent === 'One window for every model you use' && document.querySelectorAll('.home > *').length <= 2 && !document.querySelector('.home h1, .home .empty-mark')`, 'home shows only the one line');
    await shot(win, '1-home');
    await clickText(win, '.thread-row', 'Parse the release notes');
    await until(win, `document.querySelectorAll('.msg').length === 2 && !!document.querySelector('.prose table')`, 'messages render');
    await until(win, `!!document.querySelector('.top-actions [title="Terminal (tmux)"]') && !['Rename', 'Delete conversation', 'Show folder in Finder'].some(t => document.querySelector(\`.top-actions [title="\${t}"]\`))`, 'the thread header has no rename, delete, or Finder buttons');
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
    await until(win, `!!document.querySelector('.composer-wrap > .suggestions .suggestion')`, 'suggestions show as chips above the message box');
    await clickText(win, '.suggestion', 'Show the migration steps');
    await until(win, `document.querySelector('.composer textarea, textarea').value === 'Show the migration steps'`, 'a suggestion fills the composer');
    await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.composer textarea, textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    // A long prompt grows the composer; clearing it (as a send does) puts it back to one row.
    const setComposer = value => win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(value)}); t.dispatchEvent(new Event('input', { bubbles: true })); return t.getBoundingClientRect().height; })()`);
    const oneRow = await setComposer('');
    if (!(await setComposer('A long prompt line\n'.repeat(8)) > oneRow + 60)) throw new Error('a long prompt does not grow the composer');
    if (await setComposer('') !== oneRow) throw new Error('the composer stays tall after it is cleared');
    // Ghost text: the first suggestion shows in the empty box, and Tab takes it.
    const key = name => win.webContents.executeJavaScript(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`);
    await until(win, `document.querySelector('.composer textarea').placeholder === 'Show the migration steps' && !!document.querySelector('.ghost-key')`, 'the first suggestion shows as ghost text');
    await key('Tab');
    await until(win, `document.querySelector('.composer textarea').value === 'Show the migration steps' && !document.querySelector('.ghost-key')`, 'Tab takes the ghost text');
    // Inline completion: typed text that starts a suggestion shows the rest in gray, and → takes it.
    await setComposer('show the');
    await until(win, `document.querySelector('.ghost-rest')?.textContent === ' migration steps' && !document.querySelector('.composer-wrap > .suggestions')`, 'typing shows the rest of a matching suggestion');
    await shot(win, '1a-complete');
    await key('ArrowRight');
    await until(win, `document.querySelector('.composer textarea').value === 'show the migration steps' && !document.querySelector('.ghost-rest')`, '→ takes the inline completion');
    await setComposer('');
    // The / menu lists Orin's commands; Enter on /model opens the model picker.
    await setComposer('/cl');
    await until(win, `document.querySelector('.cmd-menu .cmd-item.active .cmd-name')?.textContent === '/clear'`, 'the / menu filters the commands');
    await shot(win, '1b-slash');
    await key('Escape');
    await until(win, `!document.querySelector('.cmd-menu')`, 'Escape closes the / menu');
    await setComposer('/cle');
    if (await win.webContents.executeJavaScript(`!!document.querySelector('.cmd-menu')`)) throw new Error('a closed / menu opens again for the same word');
    await setComposer('');
    await setComposer('/mod');
    await key('Enter');
    await until(win, `!!document.querySelector('.picker-pop .pick-search') && document.querySelector('.composer textarea').value === ''`, '/model opens the model picker');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    // The @ menu searches the workspace files; Enter puts the path in the text.
    await setComposer('See @CHANGE');
    await until(win, `[...document.querySelectorAll('.cmd-menu .cmd-name')].some(n => n.textContent === 'CHANGELOG.md')`, 'the @ menu finds workspace files');
    await shot(win, '1c-mention');
    await key('Enter');
    await until(win, `document.querySelector('.composer textarea').value === 'See @CHANGELOG.md ' && !document.querySelector('.cmd-menu')`, 'a picked file goes into the text');
    await setComposer('');
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
    await until(win, `[...document.querySelectorAll('.code-lang')].map(e => e.textContent).join() === 'totals.csv,Python,HTML,Mermaid'`, 'code blocks show a file name and a language');
    await until(win, `[...document.querySelectorAll('.file-card .file-name')].map(e => e.textContent).join() === 'brief.txt,report.md,totals.csv'`, 'file cards for an attachment, a written file, and a made file');
    await clickText(win, '.code-btn', 'Preview');
    await until(win, `[...document.querySelectorAll('.snippet-table td')].map(e => e.textContent).join() === 'North,12,South,9'`, 'CSV preview shows a table');
    await until(win, `(() => { const svg = document.querySelector('.mermaid-svg svg'); return !!svg && ['Plan', 'Build', 'Ship'].every(t => svg.textContent.includes(t)); })()`, 'a Mermaid block opens as a drawn diagram', 15000);
    await win.webContents.executeJavaScript(`document.querySelector('.mermaid-preview').scrollIntoView({ block: 'center' })`);
    await shot(win, '1d-files');
    // Copy puts the exact snippet on the clipboard (through main) and says so.
    clipboard.writeText('');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.code-block')[1].querySelector('[aria-label="Copy code"]').click()`);
    await until(win, `document.querySelector('.toast')?.textContent === 'Code copied to the clipboard'`, 'copy confirms with a toast');
    if (clipboard.readText() !== 'print("done")') throw new Error(`Copy wrote ${JSON.stringify(clipboard.readText())}`);
    // Run opens the HTML snippet with scripts on, in its own window without Node.js or the Orin bridge.
    const windowCount = BrowserWindow.getAllWindows().length;
    await clickText(win, '.code-btn', 'Run');
    let runWin;
    for (let i = 0; i < 50 && !runWin; i++) { await sleep(100); runWin = BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith('Run: ')); }
    if (!runWin || BrowserWindow.getAllWindows().length !== windowCount + 1) throw new Error('Timed out: Run opens a window');
    await until(runWin, `document.getElementById('out')?.textContent === 'ran undefined undefined'`, 'the snippet script runs without require or the Orin bridge');
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
    // Overseer: the first item of the model menu. It names the composer chip and hides the effort menu; a model picked by hand turns it off.
    await click(win, '.picker-pop .overseer-item');
    await until(win, `document.querySelector('.chip[title="Choose a model"] .chip-label')?.textContent.startsWith('Overseer · ') && !document.querySelector('[aria-label="Effort"]') && document.querySelector('.composer textarea').placeholder.startsWith('Message Overseer')`, 'Overseer turns on');
    await click(win, '.chip[title="Choose a model"]');
    await until(win, `document.querySelector('.picker-pop .overseer-item.selected')`, 'Overseer shows as selected');
    await shot(win, '2a-overseer');
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.picker-pop .pick-item:not(.overseer-item)')].find(b => !b.disabled && !b.classList.contains('muted')).click()`);
    await until(win, `!document.querySelector('.chip[title="Choose a model"] .chip-label')?.textContent.startsWith('Overseer')`, 'a model picked by hand turns Overseer off');
    await click(win, '.sidebar-foot .foot-btn:last-child');
    await until(win, `!!document.querySelector('.settings .row')`, 'settings opens');
    await clickText(win, '.settings .btn', 'Add a provider');
    await until(win, `!!document.querySelector('.preset-grid')`, 'provider form opens');
    await shot(win, '3-settings');
    // Local models: engine row, search, the file list with a fit rating, a download, and delete.
    await until(win, `[...document.querySelectorAll('.settings h3')].some(h => h.textContent === 'On this Mac') && document.querySelector('.local-engine')?.textContent.includes('Local engine')`, 'the Models pane shows the local engine');
    await clickText(win, '.settings .btn', 'Find models');
    await until(win, `document.querySelector('.finder-name')?.textContent === 'acme/tiny-GGUF'`, 'search lists the fake repository');
    await click(win, '.finder-head');
    await until(win, `document.querySelectorAll('.local-files li').length === 4 && document.querySelector('.local-files .lf-rec') && [...document.querySelectorAll('.local-files .btn')].some(b => b.disabled)`, 'files list with a recommended file and a too-big file that cannot download');
    await win.webContents.executeJavaScript(`document.querySelector('.local-engine').scrollIntoView({ block: 'start' })`);
    await sleep(200);
    await shot(win, '3b-local');
    await click(win, '.local-files .btn.primary');
    await until(win, `[...document.querySelectorAll('.local-files .btn')].some(b => b.textContent === 'Downloaded')`, 'the download finishes', 15000);
    await until(win, `[...document.querySelectorAll('.settings .row strong')].some(s => s.textContent === 'tiny · Q4_K_M')`, 'the downloaded model is listed');
    await win.webContents.executeJavaScript(`document.querySelector('.settings .row .icon-btn[title="Delete from this Mac"]').click()`);
    await until(win, `!!document.querySelector('.dialog .btn.danger') && document.querySelector('.dialog-title').textContent === 'Delete tiny-Q4_K_M.gguf?'`, 'delete asks first');
    await click(win, '.dialog .btn.danger');
    await until(win, `![...document.querySelectorAll('.settings .row strong')].some(s => s.textContent === 'tiny · Q4_K_M')`, 'the model is deleted');
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
    await until(win, `[...document.querySelectorAll('.settings .segmented')][0] && [...document.querySelectorAll('.settings .segmented')][0].textContent === 'DarkLightSystem' && !document.querySelector('.palette')`, 'appearance has dark, light, and system and no palettes');
    await until(win, `[...document.querySelectorAll('.settings h3')].some(h => h.textContent === 'Overseer') && document.querySelectorAll('.overseer-models .check').length > 0`, 'Overseer settings list the models it may use');
    await clickText(win, '.settings .segmented button', 'Dark');
    await until(win, `getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)'`, 'dark theme is true black');
    await clickText(win, '.settings .segmented button', 'Light');
    await until(win, `getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)'`, 'light theme is white');
    await shot(win, '5-theme');
    await until(win, `[...document.querySelectorAll('.settings .shortcut-row')].map(r => r.textContent).join('|').match(/Show Orin from any app.*⌥ Space.*\\|Orin 0\\.\\d+\\.\\d+.*Check now/) !== null`, 'desktop settings show the shortcut and the version');
    await until(win, `document.querySelector('.voice-language select')?.value === 'en' && !document.querySelector('.settings .hint.warn')`, 'voice settings show the language and a ready helper');
    await clickText(win, '.settings .shortcut-row .btn', 'Turn off');
    await until(win, `[...document.querySelectorAll('.settings .shortcut-row .btn.shortcut')][0]?.textContent === 'Off'`, 'the shortcut turns off');
    await clickText(win, '.settings .shortcut-row .btn', 'Use ⌥ Space');
    await until(win, `[...document.querySelectorAll('.settings .shortcut-row .btn.shortcut')][0]?.textContent.includes('Space')`, 'the shortcut turns on');
    await clickText(win, '.settings .segmented button', 'System');
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
    const codeThread = await win.webContents.executeJavaScript(`document.querySelector('.crumb-title')?.textContent`);
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
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.ORIN_USER_DATA, 'orin-data.json'), 'utf8'));
    await sleep(600);
    const project = JSON.parse(fs.readFileSync(path.join(process.env.ORIN_USER_DATA, 'orin-data.json'), 'utf8')).workspaces.find(w => w.kind === 'project');
    if (!project || project.instructions !== 'Write for customers.' || !fs.readFileSync(path.join(project.path, 'CLAUDE.md'), 'utf8').includes('Write for customers.')) throw new Error('Project instructions were not saved: ' + JSON.stringify(project || saved.workspaces));
    await clickText(win, '.view-switch button', 'Code');
    await until(win, `[...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'orin') && ![...document.querySelectorAll('.ws-name')].some(e => e.textContent === 'Chats')`, 'code view lists folders only');
    await until(win, `document.querySelector('.crumb-title')?.textContent === ${JSON.stringify(codeThread)}`, 'the Code tab opens its last conversation again');
    await clickText(win, '.view-switch button', 'Chat');
    await until(win, `document.querySelector('.crumb-ws')?.textContent === 'Launch plan' && !document.querySelector('.home')`, 'the Chat tab opens its last conversation again');
    await clickText(win, '.view-switch button', 'Code');
    await until(win, `document.querySelector('.crumb-title')?.textContent === ${JSON.stringify(codeThread)}`, 'the Code tab opens its last conversation after a second switch');
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
    // Terminal: the sidebar button opens tmux in xterm.js; pasted text reaches the shell and shows on screen.
    await clickText(win, '.sidebar-foot .foot-btn', 'Terminal');
    await until(win, `document.querySelector('.foot-btn.on')?.textContent.includes('Terminal') && document.querySelector('.crumb-title')?.textContent === 'tmux' && /\\[orin\\]/.test(document.querySelector('.xterm-rows')?.textContent || '')`, 'the Terminal page runs tmux', 15000);
    await win.webContents.executeJavaScript(`(() => { const data = new DataTransfer(); data.setData('text/plain', 'echo orin-smoke-input'); document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); })()`);
    await until(win, `(document.querySelector('.xterm-rows')?.textContent || '').includes('echo orin-smoke-input')`, 'typed text reaches tmux', 10000);
    await shot(win, '11-terminal');
    await clickText(win, '.thread-row', 'Quarterly table');
    await until(win, `!document.querySelector('.xterm') && !document.querySelector('.foot-btn.on') && document.querySelector('.crumb-title')?.textContent === 'Quarterly table'`, 'a conversation replaces the Terminal page');
    await click(win, '.top-actions [title="Terminal (tmux)"]');
    await until(win, `/\\[orin\\]/.test(document.querySelector('.xterm-rows')?.textContent || '')`, 'the header button opens the Terminal page and attaches again', 15000);
    await until(win, `(document.querySelector('.xterm-rows')?.textContent || '').includes('echo orin-smoke-input')`, 'the tmux session kept its screen');
    if (errors.length) throw new Error('Console errors:\n' + errors.join('\n'));
    process.stdout.write('Smoke passed: home, ghost-text suggestion, inline completion, suggestion chips, / commands, @ file mentions, saved messages, live reply with approval, elapsed time and background work, themed access and effort pickers, new conversation, model picker, settings, connector connect and disconnect, Overseer, local models (search, files, download, delete), connector presets, dark and light themes, rewind, suggested replies, questions, chat and projects, split panes, thread menu, delete dialog, focus mode, usage ring, drag to reorder, branches and pull requests, code snippet bar, copy, preview, Mermaid diagrams, and isolated Run, message edit, file cards, reply export to PDF and Word, desktop settings, voice input with live words, plan usage limits, tab memory, Terminal (tmux).\n');
    stopTmux();
    app.exit(0);
  } catch (error) {
    if (errors.length) console.error('Console errors:\n' + errors.join('\n')); process.stderr.write(String(error.stack || error) + '\n'); stopTmux(); app.exit(1); }
});
