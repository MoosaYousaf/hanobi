// A tiny stdio MCP server for tests: one tool that returns a note's text.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'notes', version: '1.0.0' });
server.registerTool('read_note', { description: 'Read a note by name', inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: 'text', text: `Note ${name}: ship on Friday` }] }));
server.connect(new StdioServerTransport());
