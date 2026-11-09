const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { searchPath } = require('./providers/cli');

const CALLBACK_PORT = 33418;
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'server';

// OAuth state for one remote server, kept in the encrypted secrets file.
class OAuthProvider {
  constructor(secrets, id) { this.secrets = secrets; this.key = `mcp-oauth:${id}`; this.interactive = false; this.pendingUrl = null; }
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: 'Orin', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  read() { return this.secrets.get(this.key) || {}; }
  write(patch) { this.secrets.set(this.key, { ...this.read(), ...patch }); }
  clientInformation() { return this.read().client; }
  saveClientInformation(client) { this.write({ client }); }
  tokens() { return this.read().tokens; }
  saveTokens(tokens) { this.write({ tokens }); }
  saveCodeVerifier(verifier) { this.write({ verifier }); }
  codeVerifier() { return this.read().verifier; }
  // Background connects never open a browser; only an explicit "Connect" click does.
  redirectToAuthorization(url) { this.pendingUrl = url; }
}

class Mcp {
  constructor({ store, secrets, openExternal, onChange }) {
    Object.assign(this, { store, secrets, openExternal, onChange });
    this.live = new Map(); // id -> { client, transport, tools }
    this.status = new Map(); // id -> { state, error, toolCount }
  }
  config(id) {
    const server = this.store.data.mcpServers.find(s => s.id === id);
    if (!server) throw new Error('MCP server not found.');
    return { ...server, ...(this.secrets.get(`mcp:${id}`) || {}) };
  }
  enabledConfigs() { return this.store.data.mcpServers.filter(s => s.enabled).map(s => this.config(s.id)); }
  setStatus(id, value) { this.status.set(id, value); this.onChange(); }
  statuses() { return Object.fromEntries(this.status); }

  transport(server, provider) {
    if (server.transport === 'stdio') {
      return new StdioClientTransport({ command: server.command, args: server.args || [], env: { ...getDefaultEnvironment(), PATH: searchPath().join(':'), ...(server.env || {}) }, stderr: 'ignore' });
    }
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers || {} }, ...(provider ? { authProvider: provider } : {}) });
  }
  async connect(id) {
    if (this.live.has(id)) return this.live.get(id);
    const server = this.config(id);
    const provider = server.oauth ? new OAuthProvider(this.secrets, id) : null;
    const client = new Client({ name: 'orin', version: '1.0.0' });
    const transport = this.transport(server, provider);
    this.setStatus(id, { state: 'connecting' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const entry = { client, transport, tools, name: server.name };
      this.live.set(id, entry);
      client.onclose = () => { this.live.delete(id); this.setStatus(id, { state: 'disconnected' }); };
      this.setStatus(id, { state: 'connected', toolCount: tools.length });
      return entry;
    } catch (error) {
      const needsAuth = error instanceof UnauthorizedError;
      this.setStatus(id, { state: needsAuth ? 'needs-auth' : 'error', error: needsAuth ? 'Sign in to connect.' : error.message });
      throw error;
    }
  }
  async disconnect(id) {
    const entry = this.live.get(id);
    this.live.delete(id);
    this.status.delete(id);
    if (entry) await entry.client.close().catch(() => {});
    this.onChange();
  }
  async reconnect(id) { await this.disconnect(id); return this.connect(id); }

  // Runs the browser sign-in for an OAuth server, then connects.
  async authorize(id) {
    const server = this.config(id);
    if (!server.oauth) return this.reconnect(id);
    await this.disconnect(id);
    const provider = new OAuthProvider(this.secrets, id);
    const transport = this.transport(server, provider);
    const code = new Promise((resolve, reject) => {
      const listener = http.createServer((req, res) => {
        const url = new URL(req.url, REDIRECT);
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const value = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<body style="font:15px -apple-system;padding:40px">${value ? 'Orin is connected. You can close this tab.' : 'Sign-in failed. Return to Orin and try again.'}</body>`);
        listener.close();
        value ? resolve(value) : reject(new Error(url.searchParams.get('error_description') || 'Sign-in was cancelled.'));
      });
      listener.on('error', reject);
      listener.listen(CALLBACK_PORT, '127.0.0.1');
      setTimeout(() => { listener.close(); reject(new Error('Sign-in timed out.')); }, 5 * 60 * 1000).unref();
    });
    try {
      await new Client({ name: 'orin', version: '1.0.0' }).connect(transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !provider.pendingUrl) throw error;
      this.setStatus(id, { state: 'authorizing' });
      await this.openExternal(provider.pendingUrl.toString());
      await transport.finishAuth(await code);
    }
    return this.connect(id);
  }

  // Tools from every enabled server, named server__tool so model tool names stay unique and valid.
  async tools() {
    const result = [];
    for (const server of this.store.data.mcpServers.filter(s => s.enabled)) {
      let entry;
      try { entry = await this.connect(server.id); } catch { continue; }
      for (const tool of entry.tools) {
        const qualified = `${slug(server.name)}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        result.push({ qualified, serverId: server.id, server: server.name, name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
      }
    }
    return result;
  }
  async call(tool, args) {
    const entry = await this.connect(tool.serverId);
    const result = await entry.client.callTool({ name: tool.name, arguments: args || {} });
    const output = (result.content || []).map(c => (c.type === 'text' ? c.text : c.type === 'resource' ? c.resource?.text ?? `[resource ${c.resource?.uri}]` : `[${c.type}]`)).join('\n');
    return { output: output || JSON.stringify(result.structuredContent ?? ''), isError: !!result.isError };
  }
  async closeAll() { await Promise.all([...this.live.keys()].map(id => this.disconnect(id))); }
}

module.exports = { Mcp, REDIRECT };
