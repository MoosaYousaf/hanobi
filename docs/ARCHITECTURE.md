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
  │       ├─ copilot-acp.js   Copilot Ask first through `copilot --acp` (Agent Client Protocol)
  │       ├─ usage.js         Context usage: Codex and Copilot session files, Claude context sizes
  │       ├─ anthropic.js   Messages API through @anthropic-ai/sdk, manual streaming tool loop
  │       ├─ openai.js      every OpenAI-compatible server through the openai SDK
  │       └─ transcript.js  neutral history → provider messages; CLI replay prompt
  ├─ mcp.js            MCP clients (stdio, Streamable HTTP, OAuth with a loopback redirect)
  ├─ git.js            async git with porcelain v2 -z, run from the repository root; branches, push, pull; checkpoints through a private index
  ├─ github.js         pull requests through the gh CLI (view, list, create with the body on stdin, checkout); no token in Hanobi
  ├─ projects.js       project folders: instructions files, knowledge/ documents, API context
  ├─ files.js          conversation files: attachments (Files/<thread>/in), model files (out), HTML to docx/rtf/odt/pdf, path checks
  ├─ extract.js        document text (PDF, Word, RTF, ODT, PowerPoint, Excel) with macOS tools, cached in knowledge/.text/
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

A workspace has a `kind`. `code` is a folder the user added. `chats` is the general Chats folder in the app data. `project` is an app-owned folder under `Projects/`, with `instructions`, a `knowledge/` folder, and generated `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`. Chats and projects are not code: CLI agents run with read-only tools, the access mode does not apply, and runs make no checkpoints. API runs in a project add `projects.apiContext()` to the system prompt. It gets document text from `extract.js`: PDFKit through JXA (`osascript`), `textutil`, and `unzip` for PowerPoint and Excel XML. The text is cached in `knowledge/.text/` and made again when the document changes.

## Checkpoints and rewind

Before each run in a code workspace, `git.snapshot` copies the real index (with its modification time, so git still rechecks files changed in the same second), runs `git add -A` against the copy, and saves the tree id on the user message. `git.restore` compares the current snapshot with the checkpoint inside the workspace folder only, deletes files that the checkpoint does not have, and writes the others from a second private index with `checkout-index`. Rewinding the conversation clears the CLI session, so the next turn replays the transcript.

## Questions

`Runner.question` sends a `question` event and resolves with answers keyed by question id, or null when the user skips. Claude Code always runs with the stdio control channel, so `AskUserQuestion` arrives as `can_use_tool` in every mode; the answers go back in `updatedInput.answers`, keyed by question text. Codex sends `item/tool/requestUserInput` in Ask first. API runs get the `hanobi__ask_user` tool.

## Approvals

`Runner.ask` is the one approval flow. API runs call it before each MCP tool call. Claude Code always runs with `--input-format stream-json --permission-prompt-tool stdio`. In **Ask first** the CLI sends each permission prompt as a `can_use_tool` control request on stdout. Hanobi answers with a `control_response` on stdin, and closes stdin after the `result` event. In the other modes Hanobi denies permission prompts, as the CLI does when nobody can answer. In **Ask first**, Codex runs `codex app-server` with `approvalPolicy: untrusted` and the workspace-write sandbox. Hanobi answers `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` with `accept` or `decline`. Other server requests get a JSON-RPC error. Thread ids are the same as in `codex exec`, so a thread can change mode and still resume. In **Ask first**, Copilot runs `copilot --acp` with allow-all off (Hanobi turns it off if a saved setting has it on). Hanobi declares no fs or terminal capability, so Copilot uses its own tools. Hanobi answers `session/request_permission` with the `allow_once` or `reject_once` option. A resumed thread uses `session/load`; Hanobi ignores the replayed updates. ACP session ids are the same as `--session-id`. A Deny makes Copilot end the turn ("Info: Operation cancelled by user"). Copilot sends such notices as message chunks, so Hanobi puts each one in its own paragraph. **Always allow** adds the tool name to the thread's `allowedTools`.

## Adding a provider

- If the provider has an OpenAI-compatible endpoint, add a preset to `catalog.js` with `kind: 'openai'` and its `baseURL`. No other change is needed.
- For a new protocol, add an adapter with `run()` and `listModels()`, and add a branch in `runner.execute`.
- For a new CLI, add a preset with `kind: 'cli'`, then add its argv in `cli.command` and its event parsing in `cli.apply`.

## Context usage

Each saved assistant message can carry `usage: { used, window }`: the tokens of the last model call in the turn (input, cache, and output) and the context size. Claude Code reports both in its stream (`assistant` message usage, `result.modelUsage[].contextWindow`). Anthropic and OpenAI-compatible APIs report `used` (OpenAI-compatible servers get `stream_options.include_usage`, except Mistral). Codex and Copilot do not stream usage; after the turn `usage.js` reads the last `token_count` event of the Codex rollout file or the last `session.usage_record` of the Copilot session log. When the provider gives no size, the runner uses the Claude table in `usage.js`. The composer shows the last message's usage as a ring.

## Files

`electron/files.js` keeps each conversation's files under `<userData>/Files/<thread id>/`. Attachments are copied to `in/<uuid>/`, so a moved original does not break the chat. Files that API models make with `hanobi__write_file` go to `out/`. A file part is `{ type: 'file', name, path, size, mediaType }`; user messages hold attachments and replies hold made files. The renderer shows cards for file parts and for paths that CLI tools wrote (`Write`, `Edit`, Codex file changes, Copilot `create`/`edit`). Every file action goes through `Files.resolve`, which accepts only real paths inside the thread's folder or its workspace (symbolic links are resolved first). Attachment text comes from `extract.js` and goes into prompts as `<attachment>` blocks: through the transcript for API models, and in the stdin prompt with paths for CLI agents. Word, RTF, and OpenDocument output come from HTML through `textutil`; PDF output comes from Chromium's printer in a hidden window with scripts off.

