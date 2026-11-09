const fs = require('node:fs');
const path = require('node:path');

// API keys and MCP credentials, encrypted with the OS keychain through Electron safeStorage.
// The file holds only ciphertext; values never go to the renderer.
class Secrets {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }
  available() { return this.safe.isEncryptionAvailable(); }
  get(key) {
    const value = this.data[key];
    if (!value) return null;
    try { return JSON.parse(this.safe.decryptString(Buffer.from(value, 'base64'))); } catch { return null; }
  }
  has(key) { return key in this.data; }
  set(key, value) {
    if (value === null || value === undefined || value === '') delete this.data[key];
    else {
      if (!this.available()) throw new Error('macOS Keychain encryption is unavailable, so Orin cannot store secrets.');
      this.data[key] = this.safe.encryptString(JSON.stringify(value)).toString('base64');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
  removePrefix(prefix) {
    const keys = Object.keys(this.data).filter(k => k.startsWith(prefix));
    if (!keys.length) return;
    for (const key of keys) delete this.data[key];
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
}

module.exports = { Secrets };
