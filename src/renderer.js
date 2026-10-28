const $ = id => document.getElementById(id);
const state = { data: null, workspaceId: null, threadId: null, gitOpen: false, panelMode: 'git', runs: new Map(), buffers: new Map() };
let lastRenderedThread = null;
let visibleCount = 120;
const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function toast(message) { const node = $('toast'); node.textContent = message; node.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.add('hidden'), 3500); }
function failure(error) { toast(error?.message || String(error)); }
function currentWorkspace() { return state.data?.workspaces.find(w => w.id === state.workspaceId); }
function currentThread() { return state.data?.threads.find(t => t.id === state.threadId); }
async function refresh() {
  state.data = await window.orbit.snapshot();
  if (!state.data.workspaces.some(w => w.id === state.workspaceId)) state.workspaceId = state.data.workspaces[0]?.id || null;
  if (!state.data.threads.some(t => t.id === state.threadId)) state.threadId = state.data.threads.find(t => t.workspaceId === state.workspaceId)?.id || null;
  renderSidebar(); renderMain();
  if (state.gitOpen && state.panelMode === 'git') refreshGit();
}
function renderSidebar() {
  const list = $('workspace-list'); list.replaceChildren();
  for (const workspace of state.data.workspaces) {
    const item = el('div', 'workspace-item');
    const head = el('button', 'workspace-header');
    head.append(el('span', 'folder-icon', '▰'), el('span', '', workspace.name), el('span', 'chevron', workspace.id === state.workspaceId ? '⌄' : '›'));
    head.onclick = () => { state.workspaceId = workspace.id; state.threadId = state.data.threads.find(t => t.workspaceId === workspace.id)?.id || null; renderSidebar(); renderMain(); if (state.gitOpen && state.panelMode === 'git') refreshGit(); };
    item.append(head);
    if (workspace.id === state.workspaceId) {
      const threads = el('div', 'thread-list');
      const add = el('button', 'new-thread', '＋ New conversation'); add.onclick = chooseProvider; threads.append(add);
      for (const thread of state.data.threads.filter(t => t.workspaceId === workspace.id).sort((a,b) => b.updatedAt - a.updatedAt)) {
        const row = el('button', 'thread' + (thread.id === state.threadId ? ' active' : ''));
        row.append(el('span', 'thread-provider', thread.provider === 'claude' ? '✦' : thread.provider === 'codex' ? '◈' : '✧'), el('span', 'thread-title', thread.title));
        row.onclick = () => { state.threadId = thread.id; renderSidebar(); renderMain(); };
        threads.append(row);
      }
      item.append(threads);
    }
    list.append(item);
  }
  const status = $('provider-status'); status.replaceChildren();
  for (const provider of state.data.providers) { const span = el('span'); span.append(el('i', 'provider-dot' + (provider.installed ? ' installed' : '')), document.createTextNode(provider.name.split(' ')[0])); status.append(span); }
}
async function chooseProvider() {
  const available = state.data.providers.filter(p => p.installed);
  if (!available.length) { toast('Install and sign in to a provider CLI first.'); return; }
  const overlay = el('div'); Object.assign(overlay.style, { position:'fixed', inset:'0', background:'#0009', display:'grid', placeItems:'center', zIndex:'20' });
  const box = el('div'); Object.assign(box.style, { width:'340px', padding:'22px', background:'#202936', border:'1px solid #4b5869', borderRadius:'13px', boxShadow:'0 24px 70px #0009' });
  box.append(el('h2', '', 'Choose an agent'), el('p', 'muted', 'Start a conversation in ' + currentWorkspace().name + '.'));
  for (const provider of state.data.providers) {
    const button = el('button', 'ghost full', provider.name + (provider.installed ? '' : ' · not installed'));
    button.disabled = !provider.installed; button.style.marginBottom = '5px';
    button.onclick = async () => { overlay.remove(); try { const t = await window.orbit.addThread(state.workspaceId, provider.id); state.threadId = t.id; await refresh(); $('prompt').focus(); } catch(e) { failure(e); } };
    box.append(button);
  }
  const cancel = el('button', 'ghost full', 'Cancel'); cancel.onclick = () => overlay.remove(); box.append(cancel); overlay.append(box); overlay.onclick = e => { if (e.target === overlay) overlay.remove(); }; document.body.append(overlay);
}
function renderMain() {
  const workspace = currentWorkspace(), thread = currentThread();
  $('workspace-name').textContent = workspace?.name || 'Workspace'; $('thread-name').textContent = thread?.title || 'Conversation';
  $('welcome').classList.toggle('hidden', !!thread); $('conversation').classList.toggle('hidden', !thread);
  $('rename-thread').disabled = !thread; $('delete-thread').disabled = !thread; $('open-folder').disabled = !workspace; $('git-button').disabled = !workspace;
  if (!thread) { $('welcome').querySelector('p').textContent = workspace ? 'Start a conversation with one of your installed coding agents.' : 'Keep your projects and conversations in one smooth desktop view. Choose a workspace, then start a conversation with Claude Code, Codex, or Gemini.'; $('welcome-add').textContent = workspace ? 'New conversation' : 'Add a workspace'; return; }
  $('provider-pill').textContent = names[thread.provider];
  renderControls(thread, workspace);
  const messages = $('messages');
  const sameThread = lastRenderedThread === thread.id;
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  const oldHeight = messages.scrollHeight;
  const oldTop = messages.scrollTop;
  if (!sameThread) visibleCount = 120;
  lastRenderedThread = thread.id;
  messages.replaceChildren();
  if (thread.messages.length > visibleCount) {
    const earlier = el('button', 'rewind', `Load earlier messages (${thread.messages.length - visibleCount} more)`);
    earlier.onclick = () => { visibleCount += 120; renderMain(); };
    messages.append(earlier);
  }
  if (!thread.messages.length) { const empty = el('div','empty-thread'); empty.append(el('div','big','✦'),el('h2','', 'What would you like to build?'),el('p','', 'Your agent will work in ' + workspace.name + '.')); messages.append(empty); }
  for (const message of thread.messages.slice(-visibleCount)) {
    const wrap = el('article', 'message ' + message.role); const head = el('div','message-head');
    head.append(el('div','avatar', message.role === 'user' ? 'Y' : '✦'), el('strong','',message.role === 'user' ? 'You' : names[thread.provider]), el('span','message-time',new Date(message.at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})));
    wrap.append(head,el('div','message-body',message.text || ''));
    if (message.tools?.length) { const tools = el('div','message-tools'); for (const tool of message.tools) { const row = el('div','tool-row'); row.append(el('strong','',tool.name || 'Tool'),el('code','',tool.detail || '')); tools.append(row); } wrap.append(tools); }
    if (message.role === 'user') { const rewind = el('button','rewind','↶ Branch from here'); rewind.title='Create a new conversation from this point'; rewind.onclick = async () => { try { const branch = await window.orbit.forkThread(thread.id,message.id); state.threadId=branch.id; await refresh(); toast('Created a conversation branch. Files were not changed.'); } catch(e) { failure(e); } }; wrap.append(rewind); }
    messages.append(wrap);
  }
  const active = state.runs.has(thread.id); $('stop').classList.toggle('hidden',!active); $('send').disabled=active;
  renderStream();
  if (!sameThread || nearBottom) messages.scrollTop = messages.scrollHeight;
  else messages.scrollTop = oldTop + (messages.scrollHeight - oldHeight);
}
function providerSettings(provider) {
  return state.data.providerSettings?.[provider] || { model: '', effort: '', mode: 'auto' };
}
function renderControls(thread, workspace) {
  const config = state.data.catalog[thread.provider];
  const settings = providerSettings(thread.provider);
  const model = $('model'); model.replaceChildren();
  for (const choice of config.models) { const option = el('option', '', choice.label); option.value = choice.id; model.append(option); }
  model.value = settings.model;
  const effort = $('effort');
  effort.disabled = config.efforts.length === 1;
  effort.max = String(config.efforts.length - 1);
  effort.value = String(Math.max(0, config.efforts.indexOf(settings.effort)));
  $('effort-value').textContent = effort.disabled ? 'CLI managed' : (settings.effort || 'Default');
  const access = $('access-mode'); access.replaceChildren();
  for (const choice of state.data.modes) { const option = el('option', '', choice.label); option.value = choice.id; access.append(option); }
  access.value = settings.mode;
  const selected = state.data.modes.find(m => m.id === settings.mode);
  $('access-detail').textContent = selected?.detail || '';
  $('access-detail').classList.toggle('danger', settings.mode === 'full');
  $('folder-context').textContent = '▰ ' + workspace.name;
  $('folder-context').title = 'Agent workspace: ' + workspace.path;
  $('folder-notice').textContent = `Working folder: ${workspace.path}. ${thread.messages.length ? 'The agent uses your existing CLI account.' : 'macOS may ask once to allow Orbit Code and the agent to access this folder.'}`;
}
async function saveControls(next) {
  const thread = currentThread(); if (!thread) return;
  try { await window.orbit.setProviderSettings(thread.provider, { ...providerSettings(thread.provider), ...next }); await refresh(); }
  catch (error) { failure(error); renderMain(); }
}
function renderStream() {
  const thread = currentThread(), node = $('stream'); if (!thread) return;
  const buffer = state.buffers.get(thread.id);
  const active = state.runs.has(thread.id);
  node.classList.toggle('hidden', !active && !buffer);
  if (active || buffer) {
    const status = el('div', 'status'); status.append(el('span', 'spinner'), document.createTextNode('AGENT WORKING'));
    node.replaceChildren(status, el('div', '', buffer?.text || (buffer?.tools.length ? buffer.tools.at(-1).name + '…' : 'Thinking…')));
    node.scrollTop = node.scrollHeight;
  }
}
async function sendPrompt() {
  const thread=currentThread(), prompt=$('prompt').value.trim(); if (!thread || !prompt) return;
  $('send').disabled=true;
  state.buffers.set(thread.id,{text:'',tools:[],partialText:''}); state.runs.set(thread.id,true); renderStream();
  try { await window.orbit.sendPrompt(thread.id,prompt); $('prompt').value=''; await refresh(); }
  catch(e) { state.buffers.delete(thread.id); state.runs.delete(thread.id); renderStream(); failure(e); $('send').disabled=false; }
}
function onRunEvent({threadId,event}) {
  let buffer=state.buffers.get(threadId); if (!buffer) { buffer={text:'',tools:[],partialText:''}; state.buffers.set(threadId,buffer); }
  if (event.text) {
    if (event.kind === 'partial') {
      if (!buffer.partialText && buffer.text) buffer.text += '\n\n';
      buffer.text += event.text;
      buffer.partialText += event.text;
    } else if (event.kind === 'result') {
      if (!buffer.text) buffer.text=event.text;
    } else if (buffer.partialText) {
      if (event.text !== buffer.partialText) buffer.text=buffer.text.slice(0,-buffer.partialText.length)+event.text;
      buffer.partialText='';
    } else if (event.text !== buffer.text) buffer.text += (buffer.text ? '\n\n' : '') + event.text;
  }
  if (event.tools?.length) buffer.tools.push(...event.tools);
  if (event.kind === 'error') buffer.error=event.text;
  if (threadId === state.threadId) renderStream();
}
async function onRunFinished({threadId,ok,error}) {
  state.buffers.delete(threadId); state.runs.delete(threadId);
  if (!ok) toast(error || 'Agent run failed.');
  await refresh();
}
async function refreshGit() {
  if (!state.workspaceId || !state.gitOpen || state.panelMode !== 'git') return;
  const content=$('git-content'); content.replaceChildren(el('p','muted','Loading changes…'));
  try {
    const result=await window.orbit.gitStatus(state.workspaceId); content.replaceChildren();
    if (result.error) { content.append(el('p','muted','This workspace is not a Git repository.')); return; }
    content.append(el('div','branch','⑂  '+result.branch));
    if (result.remote) { const link=el('button','ghost full','↗ Open repository on GitHub'); link.onclick=()=>window.orbit.openGithub(state.workspaceId).catch(failure); content.append(link); }
    if (!result.files.length) content.append(el('p','muted','Working tree is clean.'));
    for (const file of result.files) {
      const row=el('div','git-file'); const mark=el('b','',file.untracked?'?':file.staged?'S':'M'); const name=el('span','',file.path);
      name.onclick=async()=>{ try { const diff=await window.orbit.gitDiff(state.workspaceId,file.path,file.staged); content.querySelector('.diff')?.remove(); content.insertBefore(el('pre','diff',diff || 'No text diff available.'),row.nextSibling); } catch(e) { failure(e); } };
      const button=el('button','',file.staged?'−':'+'); button.title=file.staged?'Unstage':'Stage'; button.onclick=async()=>{try{await window.orbit.gitStage(state.workspaceId,file.path,file.staged);refreshGit();}catch(e){failure(e);}};
      row.append(mark,name,button);content.append(row);
    }
    const commit=el('div','commit-box'); const input=el('input');input.placeholder='Commit message';const button=el('button','primary','Commit staged changes'); button.onclick=async()=>{try{await window.orbit.gitCommit(state.workspaceId,input.value);toast('Commit created.');refreshGit();}catch(e){failure(e);}};commit.append(input,button);content.append(commit);
    $('git-count').textContent=result.files.length?'('+result.files.length+')':'';
  } catch(e) { content.replaceChildren(el('p','muted',e.message)); }
}
async function showSkills() {
  if (!state.workspaceId) { toast('Choose a workspace first.'); return; }
  try { const skills=await window.orbit.skills(state.workspaceId); state.gitOpen=true; state.panelMode='skills'; $('right-panel').classList.remove('hidden'); $('right-panel').querySelector('.eyebrow').textContent='AGENT TOOLS'; $('right-panel').querySelector('h2').textContent='Skills'; const content=$('git-content'); content.replaceChildren(); if (!skills.length) content.append(el('p','muted','No local skills found. Add skills through your provider CLI; Orbit will use the same configuration.')); for (const skill of skills) { const item=el('div','git-file');item.append(el('b','', '◇'),el('span','',skill.name),el('small','muted',skill.provider));content.append(item); } } catch(e) {failure(e);}
}
$('add-workspace').onclick=async()=>{try{const w=await window.orbit.chooseWorkspace();if(w){state.workspaceId=w.id;state.threadId=null;await refresh();}}catch(e){failure(e);}};
$('welcome-add').onclick=()=>currentWorkspace()?chooseProvider():$('add-workspace').click();
$('new-window').onclick=()=>window.orbit.openWindow().catch(failure);
$('skills-button').onclick=showSkills;
$('git-button').onclick=()=>{state.gitOpen=true;state.panelMode='git';$('right-panel').classList.remove('hidden');$('right-panel').querySelector('.eyebrow').textContent='VERSION CONTROL';$('right-panel').querySelector('h2').textContent='Changes';refreshGit();};
$('close-panel').onclick=()=>{state.gitOpen=false;$('right-panel').classList.add('hidden');};
$('open-folder').onclick=()=>window.orbit.openFolder(state.workspaceId).catch(failure);
$('rename-thread').onclick=async()=>{const t=currentThread();if(!t)return;const title=prompt('Conversation name',t.title);if(title!==null)try{await window.orbit.renameThread(t.id,title);await refresh();}catch(e){failure(e);}};
$('delete-thread').onclick=async()=>{const t=currentThread();if(!t||!confirm('Delete this conversation?'))return;try{await window.orbit.deleteThread(t.id);state.threadId=null;await refresh();}catch(e){failure(e);}};
$('send').onclick=sendPrompt;$('stop').onclick=()=>window.orbit.stopRun(state.threadId).catch(failure);
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendPrompt();}};
$('model').onchange=e=>saveControls({model:e.target.value});
$('effort').oninput=e=>{const thread=currentThread();if(thread)$('effort-value').textContent=state.data.catalog[thread.provider].efforts[Number(e.target.value)]||'Default';};
$('effort').onchange=e=>{const thread=currentThread();if(thread)saveControls({effort:state.data.catalog[thread.provider].efforts[Number(e.target.value)]});};
$('access-mode').onchange=e=>{const value=e.target.value;if(value==='full'&&!confirm('Full access lets this agent run tools without approval, including outside the workspace. Enable it?')){renderMain();return;}saveControls({mode:value});};
window.orbit.on('state-changed',()=>refresh().catch(failure));window.orbit.on('git-changed',()=>refreshGit());window.orbit.on('run-event',onRunEvent);
window.orbit.on('run-state',({threadId,running})=>{if(running)state.runs.set(threadId,true);else state.runs.delete(threadId);if(threadId===state.threadId)renderMain();});
window.orbit.on('run-finished',onRunFinished);
refresh().catch(failure);
