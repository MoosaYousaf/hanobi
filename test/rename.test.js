const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateFromHanobi } = require('../electron/rename');

const appData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orin-rename-'));

test('the Hanobi data folder moves to Orin with new file names, paths, and tool names', () => {
  const root = appData(), old = path.join(root, 'Hanobi');
  fs.mkdirSync(path.join(old, 'Files', 't1', 'in'), { recursive: true });
  fs.writeFileSync(path.join(old, 'Files', 't1', 'in', 'a.txt'), 'x');
  const file = path.join(old, 'Files', 't1', 'in', 'a.txt');
  fs.writeFileSync(path.join(old, 'hanobi-data.json'), JSON.stringify({ version: 2, threads: [{ parts: [{ type: 'file', path: file }, { type: 'tool', name: 'hanobi__write_file' }] }] }));
  fs.writeFileSync(path.join(old, 'hanobi-secrets.json'), '{}');
  assert.equal(migrateFromHanobi(root, 'Hanobi', 'Orin'), 'moved');
  const now = path.join(root, 'Orin');
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(path.join(now, 'orin-secrets.json')));
  const data = JSON.parse(fs.readFileSync(path.join(now, 'orin-data.json'), 'utf8'));
  assert.equal(data.threads[0].parts[0].path, path.join(now, 'Files', 't1', 'in', 'a.txt'));
  assert.equal(data.threads[0].parts[1].name, 'orin__write_file');
  assert.ok(fs.existsSync(data.threads[0].parts[0].path));
});

test('nothing moves when Orin data exists, when there is no Hanobi data, or when Hanobi still runs', () => {
  const root = appData();
  assert.equal(migrateFromHanobi(root, 'Hanobi', 'Orin'), 'none');
  fs.mkdirSync(path.join(root, 'Hanobi'));
  fs.symlinkSync(`host-${process.pid}`, path.join(root, 'Hanobi', 'SingletonLock'));
  assert.equal(migrateFromHanobi(root, 'Hanobi', 'Orin'), 'in-use');
  fs.mkdirSync(path.join(root, 'Orin'));
  assert.equal(migrateFromHanobi(root, 'Hanobi', 'Orin'), 'none');
  assert.ok(fs.existsSync(path.join(root, 'Hanobi')));
});

test('data from before the monochrome theme drops its palette, and the old system default becomes dark', () => {
  const { migrate } = require('../electron/store');
  const old = migrate({ version: 2, preferences: { theme: 'system', palette: 'hanobi', accent: '#e0532c' } }).preferences;
  assert.equal(old.theme, 'dark');
  assert.ok(!('palette' in old) && !('accent' in old));
  assert.equal(migrate({ version: 2, preferences: { theme: 'system' } }).preferences.theme, 'system');
  assert.equal(migrate({ version: 2, preferences: { theme: 'light', palette: 'gemini' } }).preferences.theme, 'light');
});
