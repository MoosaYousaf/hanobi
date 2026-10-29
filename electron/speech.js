const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Voice input through the speech helper (native/speech.swift): Apple speech recognition on this Mac, with no network.
// The helper records the microphone itself and prints JSON lines: ready, level, partial, final, error.
// One recording at a time. start() resolves when the microphone is on; stop() resolves with the final text.

// The region for each language when the Mac's own locale is in another language.
const LOCALES = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR', ru: 'ru-RU',
  uk: 'uk-UA', pl: 'pl-PL', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', vi: 'vi-VN', id: 'id-ID', sv: 'sv-SE' };
// The Mac's locale when it is in the chosen language (en-GB stays en-GB), else the table.
function localeFor(language = 'en', system = '') {
  const own = String(system).replace('_', '-');
  return own.split('-')[0] === language && own.includes('-') ? own : LOCALES[language] || language;
}

class Speech {
  constructor({ helper, onEvent = () => {} }) {
    Object.assign(this, { helper, onEvent });
    this.current = null; // { child, final: Promise<string> }
  }
  available() { return !!this.helper && fs.existsSync(this.helper); }

  start(locale) {
    if (this.current) return Promise.reject(new Error('Voice input is already on.'));
    if (!this.available()) return Promise.reject(new Error('The speech helper is missing. Run npm run build with the Xcode Command Line Tools installed.'));
    const child = spawn(this.helper, [locale], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    let ready, failed, done, lost, stderr = '', pending = '', settled = false;
    const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    const final = new Promise((resolve, reject) => { done = resolve; lost = reject; });
    final.catch(() => {}); // a failure before ready is reported by start()
    const current = { child, final };
    this.current = current;
    const end = (error, text) => {
      if (settled) return;
      settled = true;
      if (this.current === current) this.current = null;
      if (error) { failed(error); lost(error); } else { ready(); done(text); }
    };
    const handle = line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'ready') ready();
      else if (event.type === 'level' || event.type === 'partial') this.onEvent(event);
      else if (event.type === 'final') end(null, String(event.text || '').trim());
      else if (event.type === 'error') end(new Error(event.message || 'Speech recognition failed.'));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { const lines = (pending + chunk).split('\n'); pending = lines.pop(); lines.filter(l => l.trim()).forEach(handle); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => end(error));
    // SIGABRT (134) is macOS stopping the helper: the app has no speech permission text in its Info.plist.
    child.on('close', (code, signal) => end(code === 134 || signal === 'SIGABRT'
      ? new Error('macOS stopped speech recognition because this copy of Hanobi has no speech permission text. Run npm run build, or reinstall Hanobi.')
      : code ? new Error(stderr.trim() || `The speech helper stopped with code ${code}.`) : null, ''));
    return started;
  }

  // Ends the audio and waits for the final text.
  stop() {
    if (!this.current) return Promise.resolve('');
    const { child, final } = this.current;
    child.stdin.write('stop\n');
    const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
    return final.finally(() => clearTimeout(timer));
  }

  cancel() {
    if (!this.current) return;
    const { child } = this.current;
    this.current = null;
    child.stdin.write('cancel\n');
    setTimeout(() => child.kill('SIGTERM'), 1000).unref();
  }
}

module.exports = { Speech, localeFor, LOCALES };
