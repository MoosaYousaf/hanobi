// Builds the speech helper (native/speech.swift) into dist/native/hanobi-speech, a universal binary for Intel and
// Apple Silicon. It needs the Xcode Command Line Tools (swiftc); without them voice input reports that it is missing.
// macOS stops a process that asks for speech permission when its app has no NSSpeechRecognitionUsageDescription.
// Packaged builds get the key from package.json; this script also adds it to the development Electron.app.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);
const root = path.join(__dirname, '..');
const source = path.join(root, 'native/speech.swift');
const out = path.join(root, 'dist/native/hanobi-speech');
const quiet = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const works = (cmd, args) => { try { quiet(cmd, args); return true; } catch { return false; } };

const SPEECH_TEXT = 'Hanobi turns your speech into text on this Mac for voice input. Audio is not sent anywhere.';
function patchDevElectron() {
  let binary;
  try { binary = require('electron'); } catch { return; }
  if (typeof binary !== 'string') return;
  const bundle = path.resolve(binary, '../../..'), plist = path.join(bundle, 'Contents/Info.plist');
  if (!fs.existsSync(plist) || works('/usr/libexec/PlistBuddy', ['-c', 'Print :NSSpeechRecognitionUsageDescription', plist])) return;
  const signed = works('codesign', ['-dv', bundle]);
  quiet('/usr/libexec/PlistBuddy', ['-c', `Add :NSSpeechRecognitionUsageDescription string ${SPEECH_TEXT}`, plist]);
  // A changed Info.plist breaks an existing signature; Apple Silicon needs a valid (ad-hoc) one to run.
  if (signed) quiet('codesign', ['--force', '--deep', '--sign', '-', bundle]);
  console.log('Added the speech permission text to the development Electron.app.');
}

function build() {
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(source).mtimeMs) return;
  if (!works('xcrun', ['--find', 'swiftc'])) { console.warn('swiftc not found: voice input needs the Xcode Command Line Tools (xcode-select --install).'); return; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const slices = [];
  for (const arch of ['x86_64', 'arm64']) {
    const slice = `${out}-${arch}`;
    try { quiet('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos12.0`, source, '-o', slice]); slices.push(slice); }
    catch (error) { console.warn(`The speech helper did not build for ${arch}: ${error.stderr?.toString().trim() || error.message}`); }
  }
  if (!slices.length) process.exit(1);
  quiet('lipo', ['-create', ...slices, '-output', out]);
  slices.forEach(s => fs.rmSync(s));
  console.log(`Built ${path.relative(root, out)} (${slices.length === 2 ? 'universal' : slices[0].split('-').pop()}).`);
}

build();
patchDevElectron();
