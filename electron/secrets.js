const fs = require('node:fs');
const { writeJson } = require('./atomic');

// API keys and MCP credentials, encrypted with the OS keychain through Electron safeStorage.
// The file holds only ciphertext; values never go to the renderer.
class Secrets {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data) || Object.values(this.data).some(v => typeof v !== 'string')) throw new Error('Invalid secrets file.');
    } catch (error) {
      this.data = {};
      if (error.code !== 'ENOENT') {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, backup);
        this.warning = `Saved credentials could not be read. A recovery copy is at ${backup}.`;
      }
    }
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
    writeJson(this.file, this.data);
  }
  removePrefix(prefix) {
    const keys = Object.keys(this.data).filter(k => k.startsWith(prefix));
    if (!keys.length) return;
    for (const key of keys) delete this.data[key];
    writeJson(this.file, this.data);
  }
}

module.exports = { Secrets };
