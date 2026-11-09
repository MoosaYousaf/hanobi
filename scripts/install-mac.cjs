// Builds Orin and installs it in /Applications, replacing an older copy. Run it again after git pull to update.
// The app gets a free ad-hoc signature (Apple Silicon needs one to run) and no quarantine flag, so it opens without a warning.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options });
const root = path.join(__dirname, '..');
const target = process.env.ORIN_INSTALL_DIR || '/Applications';

run('npm', ['run', 'build'], { cwd: root });
run('npx', ['electron-builder', '--mac', 'dir', '--publish', 'never'], { cwd: root });
const out = path.join(root, 'dist/release');
const folder = fs.readdirSync(out).find(d => /^mac/.test(d) && fs.existsSync(path.join(out, d, 'Orin.app')));
if (!folder) throw new Error('The build made no Orin.app.');
const built = path.join(out, folder, 'Orin.app');

// Quit a running copy first, so its data is saved and the files can be replaced. Hanobi is Orin's old name: it must be
// closed too, so that Orin can move its data folder at the first start.
const names = ['Orin', 'Hanobi'];
for (const name of names) try { execFileSync('osascript', ['-e', `if application "${name}" is running then tell application "${name}" to quit`]); } catch {}
const running = () => names.find(name => { try { execFileSync('pgrep', ['-x', name], { stdio: 'ignore' }); return true; } catch { return false; } });
for (let i = 0; i < 50 && running(); i++) execFileSync('sleep', ['0.2']);
if (running()) throw new Error(`${running()} is still running. Quit it, then run this again.`);

const installed = path.join(target, 'Orin.app');
fs.rmSync(installed, { recursive: true, force: true });
run('ditto', [built, installed]);
run('codesign', ['--force', '--deep', '--sign', '-', installed]);
run('xattr', ['-cr', installed]);
console.log(`\nInstalled ${installed}. Open it from Spotlight, Launchpad, or the Applications folder.`);
if (fs.existsSync(path.join(target, 'Hanobi.app'))) console.log(`The old ${path.join(target, 'Hanobi.app')} is still there. Orin moves its data at the first start; then you can delete the old app.`);
