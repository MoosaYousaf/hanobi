// Builds Hanobi and installs it in /Applications, replacing an older copy. Run it again after git pull to update.
// The app gets a free ad-hoc signature (Apple Silicon needs one to run) and no quarantine flag, so it opens without a warning.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options });
const root = path.join(__dirname, '..');
const target = process.env.HANOBI_INSTALL_DIR || '/Applications';

run('npx', ['vite', 'build'], { cwd: root });
run('npx', ['electron-builder', '--mac', 'dir', '--publish', 'never'], { cwd: root });
const out = path.join(root, 'dist/release');
const folder = fs.readdirSync(out).find(d => /^mac/.test(d) && fs.existsSync(path.join(out, d, 'Hanobi.app')));
if (!folder) throw new Error('The build made no Hanobi.app.');
const built = path.join(out, folder, 'Hanobi.app');

// Quit a running copy first, so its data is saved and the files can be replaced.
try { execFileSync('osascript', ['-e', 'if application "Hanobi" is running then tell application "Hanobi" to quit']); } catch {}
const running = () => { try { execFileSync('pgrep', ['-x', 'Hanobi'], { stdio: 'ignore' }); return true; } catch { return false; } };
for (let i = 0; i < 50 && running(); i++) execFileSync('sleep', ['0.2']);
if (running()) throw new Error('Hanobi is still running. Quit it, then run this again.');

const installed = path.join(target, 'Hanobi.app');
fs.rmSync(installed, { recursive: true, force: true });
run('ditto', [built, installed]);
run('codesign', ['--force', '--deep', '--sign', '-', installed]);
run('xattr', ['-cr', installed]);
console.log(`\nInstalled ${installed}. Open it from Spotlight, Launchpad, or the Applications folder.`);
