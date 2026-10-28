const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { command, normalize } = require('../src/providers');
const { validate } = require('../src/catalog');
const git = require('../src/git');
const { spawnSync } = require('node:child_process');

test('threads persist and rewind branches preserve earlier messages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-store-'));
  try {
    const store = new Store(path.join(root, 'data.json'));
    const workspace = store.addWorkspace(root);
    const thread = store.addThread(workspace.id, 'claude');
    store.append(thread.id, { role: 'user', text: 'First task' });
    const first = store.thread(thread.id).messages[0].id;
    store.append(thread.id, { role: 'assistant', text: 'Done' });
    const branch = store.fork(thread.id, first);
    assert.equal(branch.messages.length, 1);
    assert.equal(branch.replay, true);
    assert.equal(new Store(path.join(root, 'data.json')).thread(branch.id).messages[0].text, 'First task');
    store.setSettings('claude', { model:'claude-opus-5-5', effort:'high', mode:'read' });
    assert.equal(new Store(path.join(root, 'data.json')).settings('claude').model, 'claude-opus-5-5');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider commands place model and resume arguments correctly', () => {
  assert.deepEqual(command('codex', 'hello', 'session', { model: 'gpt-6.1-sol', effort: 'high', mode: 'auto' }), ['exec','--json','--skip-git-repo-check','--sandbox','workspace-write','-c','approval_policy="never"','--model','gpt-6.1-sol','-c','model_reasoning_effort="high"','resume','session','hello']);
  assert.ok(command('claude','hello',null,{mode:'auto',effort:'max'}).includes('acceptEdits'));
  assert.ok(command('claude','hello',null,{mode:'auto',effort:'max'}).includes('--effort'));
  assert.ok(command('claude','hello',null,{mode:'full'}).includes('bypassPermissions'));
  assert.ok(command('gemini','hello',null,{mode:'auto'}).includes('auto_edit'));
  assert.ok(command('gemini','hello',null,{mode:'read'}).includes('plan'));
  assert.throws(() => validate('gemini',{model:'',effort:'high',mode:'auto'}));
  assert.deepEqual(normalize('codex', { type:'thread.started', thread_id:'abc' }), { kind:'session', id:'abc' });
  assert.deepEqual(normalize('claude', {type:'stream_event', event:{type:'content_block_delta',delta:{type:'text_delta',text:'Hi'}}}),{kind:'partial',text:'Hi'});
});

test('git status reads changes and GitHub origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-git-'));
  const run = (...args) => { const r=spawnSync('git',args,{cwd:root,encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  try {
    run('init','-q');run('remote','add','origin','git@github.com:example/project.git');
    fs.writeFileSync(path.join(root,'file.txt'),'hello');
    const status=git.status(root);
    assert.equal(status.remote,'https://github.com/example/project');
    assert.equal(status.files[0].path,'file.txt');
    git.stage(root,'file.txt',false);
    assert.equal(git.status(root).files[0].staged,true);
    git.stage(root,'file.txt',true);
    assert.equal(git.status(root).files[0].staged,false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
