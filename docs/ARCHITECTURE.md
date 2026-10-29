# Architecture

Hanobi has two processes. The Electron main process (`electron/`) owns all data, secrets, model calls, and tools. The React renderer (`renderer/`) only displays state and sends user actions.

```
renderer (React, sandboxed)
  │  window.hanobi.invoke(channel, …)   ← one IPC handler per action in electron/main.js
  │  window.hanobi.on(event, …)         ← changed, thread-changed, run-update, run-state, approval
electron/main.js
  ├─ store.js          JSON data file, coalesced atomic writes, v1 migration, corrupt-file recovery
  ├─ secrets.js        safeStorage (Keychain) encrypted keys, MCP env/headers, OAuth tokens
  ├─ runner.js         one run per conversation: adapter choice, live draft updates, tool approval
  │   ├─ draft.js      the only stream reducer: events → message parts
  │   └─ providers/
  │       ├─ catalog.js     presets for every route, access modes, settings validation
  │       ├─ cli.js         Claude Code / Codex / Gemini CLI: argv, prompt on stdin, JSON event parsing
  │       ├─ anthropic.js   Messages API through @anthropic-ai/sdk, manual streaming tool loop
  │       ├─ openai.js      every OpenAI-compatible server through the openai SDK
  │       └─ transcript.js  neutral history → provider messages; CLI replay prompt
  ├─ mcp.js            MCP clients (stdio, Streamable HTTP, OAuth with a loopback redirect)
  ├─ git.js            async git with porcelain v2 -z, run from the repository root
  └─ skills.js         read-only skill discovery
```

## Data model

- **Connection:** one configured model source. CLI connections exist when the CLI is installed. API and local connections are records in the data file. Their keys are in the secrets file under `key:<id>`.
- **Thread:** `{ connectionId, model, effort, mode, sessionId, replay, messages }`. A CLI thread resumes its CLI session. A branch, or a thread that switched provider, sets `replay`, and the next turn sends a transcript.
- **Message:** `{ role, parts, native? }`. Parts are `text`, `thinking`, `tool`, and `image`. `native` holds the exact provider request messages of an assistant turn, so the same provider replays them unchanged. This keeps Anthropic thinking blocks valid across turns.

## Streaming

Adapters write into a `Draft`. The runner sends the draft parts to the renderer at most every 60 ms. Only the live message component subscribes to them. When the run ends, the runner saves the final parts as one assistant message.

## Adding a provider

- If the provider has an OpenAI-compatible endpoint, add a preset to `catalog.js` with `kind: 'openai'` and its `baseURL`. No other change is needed.
- For a new protocol, add an adapter with `run()` and `listModels()`, and add a branch in `runner.execute`.
- For a new CLI, add a preset with `kind: 'cli'`, then add its argv in `cli.command` and its event parsing in `cli.apply`.
