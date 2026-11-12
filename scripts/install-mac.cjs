// Builds Orin and installs it in /Applications, replacing an older copy. Run it again after git pull to update.
// The app gets a free ad-hoc signature (Apple Silicon needs one to run) and no quarantine flag, so it opens without a warning.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options });
const root = path.join(__dirname, '..');
const target = process.env.ORIN_INSTALL_DIR || '/Applications';

// Replacing a running app can interrupt an active model session. Leave it open and refuse the install.
// Hanobi is Orin's old name; it must also be closed before its data can migrate safely.
const names = ['Orin', 'Hanobi'];
const running = () => {
  const commands = execFileSync('ps', ['-axo', 'comm'], { encoding: 'utf8' }).split('\n').map(s => s.trim());
  return names.find(name => commands.some(command => command.endsWith(`/${name}.app/Contents/MacOS/${name}`)));
};
const assertStopped = () => {
  const active = running();
  if (active) throw new Error(`${active} is running. Finish your session and quit it when ready, then run this again. Nothing was closed or replaced.`);
};
assertStopped();


run('npm', ['run', 'build'], { cwd: root });
run('npx', ['electron-builder', '--mac', 'dir', '--publish', 'never'], { cwd: root });
const out = path.join(root, 'dist/release');
const folder = fs.readdirSync(out).find(d => /^mac/.test(d) && fs.existsSync(path.join(out, d, 'Orin.app')));
if (!folder) throw new Error('The build made no Orin.app.');
const built = path.join(out, folder, 'Orin.app');

// Check again in case the app was opened while the build ran.
assertStopped();

const installed = path.join(target, 'Orin.app');
fs.rmSync(installed, { recursive: true, force: true });
run('ditto', [built, installed]);
run('codesign', ['--force', '--deep', '--sign', '-', installed]);
run('xattr', ['-cr', installed]);
console.log(`\nInstalled ${installed}. Open it from Spotlight, Launchpad, or the Applications folder.`);
if (fs.existsSync(path.join(target, 'Hanobi.app'))) console.log(`The old ${path.join(target, 'Hanobi.app')} is still there. Orin moves its data at the first start; then you can delete the old app.`);
