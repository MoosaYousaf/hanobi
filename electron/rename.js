// Orin was called Hanobi. On the first start after the rename, the old data folder moves to the new name, its files
// get the new names, and saved paths and tool names in the data point to the new places.
const fs = require('node:fs');
const path = require('node:path');

// True when the app that owns a data folder still runs: Chromium's SingletonLock links to "<host>-<pid>".
function inUse(folder) {
  try {
    const pid = Number(fs.readlinkSync(path.join(folder, 'SingletonLock')).split('-').pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) { return error.code === 'EPERM'; }
}

// Moves appData/<oldName> to appData/<newName> when only the old one exists. Returns what it did.
function migrateFromHanobi(appData, oldName, newName) {
  const from = path.join(appData, oldName), to = path.join(appData, newName);
  if (fs.existsSync(to) || !fs.existsSync(from)) return 'none';
  if (inUse(from)) return 'in-use';
  fs.renameSync(from, to);
  for (const [a, b] of [['hanobi-data.json', 'orin-data.json'], ['hanobi-secrets.json', 'orin-secrets.json']]) {
    if (fs.existsSync(path.join(to, a))) fs.renameSync(path.join(to, a), path.join(to, b));
  }
  const data = path.join(to, 'orin-data.json');
  if (fs.existsSync(data)) {
    // JSON escapes no character of these strings, so a text replace keeps the file valid.
    const text = fs.readFileSync(data, 'utf8')
      .split(`${from}${path.sep}`).join(`${to}${path.sep}`)
      .split('"hanobi__').join('"orin__');
    fs.writeFileSync(data, text, { mode: 0o600 });
  }
  return 'moved';
}

module.exports = { migrateFromHanobi };
