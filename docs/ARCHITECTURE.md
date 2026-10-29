# Architecture

Hanobi has two processes. The Electron main process (`electron/`) owns all data, secrets, model calls, and tools. The React renderer (`renderer/`) only displays state and sends user actions.

```
renderer (React, sandboxed)
  │  window.hanobi.invoke(channel, …)   ← one IPC handler per action in electron/main.js
  │  window.hanobi.on(event, …)         ← changed, thread-changed, run-update, run-state, approval, approval-done, question
electron/main.js
  ├─ store.js          JSON data file, coalesced atomic writes, v1 migration, corrupt-file recovery
  ├─ secrets.js        safeStorage (Keychain) encrypted keys, MCP env/headers, OAuth tokens
  ├─ runner.js         one run per conversation: adapter choice, live draft updates, tool approval
  │   ├─ draft.js      the only stream reducer: events → message parts
  │   └─ providers/
  │       ├─ catalog.js     presets for every route, access modes, settings validation
  │       ├─ cli.js         Claude Code / Codex / Gemini / Copilot CLI: argv, prompt on stdin, JSON event parsing, Claude Code control requests
  │       ├─ codex-server.js  Codex Ask first through `codex app-server` JSON-RPC
  │       ├─ anthropic.js   Messages API through @anthropic-ai/sdk, manual streaming tool loop
  │       ├─ openai.js      every OpenAI-compatible server through the openai SDK
  │       └─ transcript.js  neutral history → provider messages; CLI replay prompt
  ├─ mcp.js            MCP clients (stdio, Streamable HTTP, OAuth with a loopback redirect)
  ├─ git.js            async git with porcelain v2 -z, run from the repository root; checkpoints through a private index
  ├─ projects.js       project folders: instructions files, knowledge/ documents, API context
  ├─ suggest.js        suggested-replies prompt and parsing
  └─ skills.js         read-only skill discovery
```

## Data model

- **Connection:** one configured model source. CLI connections exist when the CLI is installed. API and local connections are records in the data file. Their keys are in the secrets file under `key:<id>`.
- **Thread:** `{ connectionId, model, effort, mode, sessionId, replay, messages }`. A CLI thread resumes its CLI session. A branch, or a thread that switched provider, sets `replay`, and the next turn sends a transcript.
- **Message:** `{ role, parts, native? }`. Parts are `text`, `thinking`, `tool`, and `image`. `native` holds the exact provider request messages of an assistant turn, so the same provider replays them unchanged. This keeps Anthropic thinking blocks valid across turns.

## Streaming

Adapters write into a `Draft`. The runner sends the draft parts to the renderer at most every 60 ms. Only the live message component subscribes to them. When the run ends, the runner saves the final parts as one assistant message.

## Workspaces

A workspace has a `kind`. `code` is a folder the user added. `chats` is the general Chats folder in the app data. `project` is an app-owned folder under `Projects/`, with `instructions`, a `knowledge/` folder, and generated `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`. Chats and projects are not code: CLI agents run with read-only tools, the access mode does not apply, and runs make no checkpoints. API runs in a project add `projects.apiContext()` to the system prompt.

## Checkpoints and rewind

Before each run in a code workspace, `git.snapshot` copies the real index (with its modification time, so git still rechecks files changed in the same second), runs `git add -A` against the copy, and saves the tree id on the user message. `git.restore` compares the current snapshot with the checkpoint inside the workspace folder only, deletes files that the checkpoint does not have, and writes the others from a second private index with `checkout-index`. Rewinding the conversation clears the CLI session, so the next turn replays the transcript.

## Questions

`Runner.question` sends a `question` event and resolves with answers keyed by question id, or null when the user skips. Claude Code always runs with the stdio control channel, so `AskUserQuestion` arrives as `can_use_tool` in every mode; the answers go back in `updatedInput.answers`, keyed by question text. Codex sends `item/tool/requestUserInput` in Ask first. API runs get the `hanobi__ask_user` tool.

## Approvals

`Runner.ask` is the one approval flow. API runs call it before each MCP tool call. Claude Code always runs with `--input-format stream-json --permission-prompt-tool stdio`. In **Ask first** the CLI sends each permission prompt as a `can_use_tool` control request on stdout. Hanobi answers with a `control_response` on stdin, and closes stdin after the `result` event. In the other modes Hanobi denies permission prompts, as the CLI does when nobody can answer. In **Ask first**, Codex runs `codex app-server` with `approvalPolicy: untrusted` and the workspace-write sandbox. Hanobi answers `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` with `accept` or `decline`. Other server requests get a JSON-RPC error. Thread ids are the same as in `codex exec`, so a thread can change mode and still resume. **Always allow** adds the tool name to the thread's `allowedTools`.

## Adding a provider

- If the provider has an OpenAI-compatible endpoint, add a preset to `catalog.js` with `kind: 'openai'` and its `baseURL`. No other change is needed.
- For a new protocol, add an adapter with `run()` and `listModels()`, and add a branch in `runner.execute`.
- For a new CLI, add a preset with `kind: 'cli'`, then add its argv in `cli.command` and its event parsing in `cli.apply`.
