# Architecture

Orin has two processes. The Electron main process (`electron/`) owns all data, secrets, model calls, and tools. The React renderer (`renderer/`) only displays state and sends user actions.

```
renderer (React, sandboxed)
  │  window.orin.invoke(channel, …)   ← one IPC handler per action in electron/main.js
  │  window.orin.on(event, …)         ← changed, thread-changed, run-update, run-state, approval, approval-done, question
electron/main.js
  ├─ store.js          JSON data file, coalesced atomic writes, v1 migration, corrupt-file recovery
  ├─ secrets.js        safeStorage (Keychain) encrypted keys, MCP env/headers, OAuth tokens
  ├─ runner.js         one run per conversation: adapter choice, live draft updates, tool approval
  │   ├─ overseer.js   Overseer: per-turn choice of connection, model, and effort (rules, router model, plan limits)
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
  ├─ github.js         pull requests through the gh CLI (view, list, create with the body on stdin, checkout); no token in Orin
  ├─ projects.js       project folders: instructions files, knowledge/ documents, API context
  ├─ desktop.js        window bounds, background notifications and Dock badge, update check against GitHub Releases
  ├─ speech.js         voice input through native/speech.swift (Apple speech recognition, on-device): start, partial text, stop, cancel
  ├─ limits.js         plan limits of the CLI subscriptions: Claude OAuth usage, Codex rate_limits in session logs, Copilot quotas via gh
  ├─ files.js          conversation files: attachments (Files/<thread>/in), model files (out), HTML to docx/rtf/odt/pdf, path checks
  ├─ extract.js        document text (PDF, Word, RTF, ODT, PowerPoint, Excel) with macOS tools, cached in knowledge/.text/
  ├─ hf.js             local models: Hugging Face search and file list (fit estimate), resumable SHA-256-checked downloads, the Library of downloaded files
  ├─ llama.js          local engine: builds llama.cpp's llama-server from a pinned release, starts it for one model at a time (OpenAI API on 127.0.0.1)
  ├─ models-catalog.js model catalog from models.dev (release dates, prices), once a day; Claude Code's model menu and model strength
  ├─ suggest.js        suggested-replies prompt and parsing
  ├─ commands.js       / commands (custom command files and skills, expanded for non-Claude models), @ file search and mentions
  └─ skills.js         read-only skill discovery
```

## Data model

- **Connection:** one configured model source. CLI connections exist when the CLI is installed. API and local connections are records in the data file. Their keys are in the secrets file under `key:<id>`.
- **Thread:** `{ connectionId, model, effort, mode, sessionId, replay, messages }`. A CLI thread resumes its CLI session. A branch, or a thread that switched provider, sets `replay`, and the next turn sends a transcript.
- **Message:** `{ role, parts, native? }`. Parts are `text`, `thinking`, `tool`, and `image`. `native` holds the exact provider request messages of an assistant turn, so the same provider replays them unchanged. This keeps Anthropic thinking blocks valid across turns.

## Streaming

Adapters write into a `Draft`. The runner sends the draft parts to the renderer at most every 60 ms. Only the live message component subscribes to them. When the run ends, the runner saves the final parts as one assistant message. `run-state` carries the run's `startedAt`, so the live status line counts the time and opens the turn's thinking and tool calls; the saved message keeps `duration` (ms).

## Workspaces

A workspace has a `kind`. `code` is a folder the user added. `chats` is the general Chats folder in the app data. `project` is an app-owned folder under `Projects/`, with `instructions`, a `knowledge/` folder, and generated `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`. Chats and projects are not code: CLI agents run with read-only tools, the access mode does not apply, and runs make no checkpoints. API runs in a project add `projects.apiContext()` to the system prompt. It gets document text from `extract.js`: PDFKit through JXA (`osascript`), `textutil`, and `unzip` for PowerPoint and Excel XML. The text is cached in `knowledge/.text/` and made again when the document changes.

## Checkpoints and rewind

Before each run in a code workspace, `git.snapshot` copies the real index (with its modification time, so git still rechecks files changed in the same second), runs `git add -A` against the copy, and saves the tree id on the user message. `git.restore` compares the current snapshot with the checkpoint inside the workspace folder only, deletes files that the checkpoint does not have, and writes the others from a second private index with `checkout-index`. Rewinding the conversation clears the CLI session, so the next turn replays the transcript.

## Questions

`Runner.question` sends a `question` event and resolves with answers keyed by question id, or null when the user skips. Claude Code always runs with the stdio control channel, so `AskUserQuestion` arrives as `can_use_tool` in every mode; the answers go back in `updatedInput.answers`, keyed by question text. Codex sends `item/tool/requestUserInput` in Ask first. API runs get the `orin__ask_user` tool.

## Approvals

`Runner.ask` is the one approval flow. API runs call it before each MCP tool call. Claude Code always runs with `--input-format stream-json --permission-prompt-tool stdio`. In **Ask first** the CLI sends each permission prompt as a `can_use_tool` control request on stdout. Orin answers with a `control_response` on stdin, and closes stdin after the `result` event. In the other modes Orin denies permission prompts, as the CLI does when nobody can answer. In **Ask first**, Codex runs `codex app-server` with `approvalPolicy: untrusted` and the workspace-write sandbox. Orin answers `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` with `accept` or `decline`. Other server requests get a JSON-RPC error. Thread ids are the same as in `codex exec`, so a thread can change mode and still resume. In **Ask first**, Copilot runs `copilot --acp` with allow-all off (Orin turns it off if a saved setting has it on). Orin declares no fs or terminal capability, so Copilot uses its own tools. Orin answers `session/request_permission` with the `allow_once` or `reject_once` option. A resumed thread uses `session/load`; Orin ignores the replayed updates. ACP session ids are the same as `--session-id`. A Deny makes Copilot end the turn ("Info: Operation cancelled by user"). Copilot sends such notices as message chunks, so Orin puts each one in its own paragraph. **Always allow** adds the tool name to the thread's `allowedTools`.

## Overseer

A thread with `overseer: true` gets its model chosen before each turn (`Runner.route`, `electron/overseer.js`). Candidates are the ready connections' models without CLI defaults; paid-key connections only with `allowPaid`; a CLI only after it gave a reply without an error in some thread, or when the user included its model (an installed CLI may not be signed in). Each model has a tier (`top`, `mid`, `fast`) from the `TIERS` table or from words in its id; local models are always `fast`. `classify` calls a message `quick`, `normal`, or `hard`. When the kind matches the previous route and that model is under the soft limit (80%), the thread stays (`by: 'same'`, no model call). Otherwise the router model (Haiku 5.5 through `cli.complete`, 10 s limit) returns `{id, effort, reason}` as JSON; an unknown id, bad JSON, an error, or the setting `router: 'rules'` falls back to `byRules`: plans under the soft limit, the nearest tier (stronger first), the previous connection, subscriptions before local before keys, then the plan with the most left. Plans at the hard limit (90%) are out. The route moves the thread like a model change (another connection replays the transcript), keeps the user's access mode in `baseMode` (`mapMode` gives the closest mode of each provider), and is saved on the thread (`route`) and on the reply (`route: { reason, by, effort }`). Choosing a model by hand turns the Overseer off.

## Model catalog

`electron/models-catalog.js` downloads `https://models.dev/api.json` (free, no key, about 6 MB) once a day and keeps a short form (id, name, release date, output price, context) for seven providers in `<userData>/models-catalog.json`. A failed download keeps the last copy. It does three jobs. (1) Claude Code has no model list, so its menu is the catalog's Anthropic models: the newest of each family plus everything from the last 90 days. (2) Codex lists its own models through `codex app-server` (`model/list`, no model call). Both lists are saved in `modelCache` and refresh every 6 hours (`Runner.refreshCatalog`) or with the reload button; the menu shows "CLI default" and then the list, and the built-in list stays valid for old conversations (`validateSettings`). (3) A model released in the last 14 days gets a "New" badge, and the Overseer takes each model's strength from its output price (top from $15 per million tokens, mid from $2) and prefers the cheaper model in a strength group.

## Local models

Models that run on the user's Mac. `electron/hf.js` searches Hugging Face (`/api/models?filter=gguf&pipeline_tag=text-generation`, sorted by trending, downloads, new, or likes) and lists a repository's `.gguf` files (`tree/main?recursive=true`): split files are one entry, vision projectors and importance matrices are left out, and each file gets a fit rating from the RAM (weights plus 0.6 GB: up to 45% of RAM "good", up to 70% "tight", more "no", which main refuses). The recommended file is the first of Q4_K_M, Q4_K_S, Q4_0… that is "good". `Downloads` writes `<name>.part`, resumes with a Range request, hashes while it writes, and compares the SHA-256 that Hugging Face lists (`lfs.oid`); a mismatch deletes the file. Main looks the file up again, so size and hash never come from the renderer. Names are checked (repository pattern, no `..`, `.gguf` only). Files go to `<userData>/Models/<owner>__<repo>/`, each with a `.gguf.json` note. Gated models (HTTP 401/403) are reported and not downloaded: Orin stores no Hugging Face token.

`electron/llama.js` is the engine. No ready-made runtime works on macOS 12: llama.cpp's release binaries need macOS 13.3 (and fail with a missing Accelerate symbol), Ollama needs macOS 14, LM Studio needs Apple Silicon and macOS 14. So Orin builds `llama-server` once from the pinned release tag `TAG` (built and run on macOS 12.7.6 Intel; moving the tag is a code change), with CMake and the Xcode Command Line Tools: the source is downloaded into its own folder and the tools run from outside it, with the web UI, OpenSSL and shared libraries off (a build with OpenSSL links Homebrew's copy) and the deployment target set to this Mac's macOS. Progress comes from the `[n/total]` lines of the build. `use(modelId)` starts `llama-server --model … --host 127.0.0.1 --port <free> --alias <id> --ctx-size <by RAM> --threads <physical cores> --parallel 1 --jinja --no-webui`, waits for `/health`, and returns the URL. One model is in memory at a time; `done()` ends a use; the server stops after 10 idle minutes (`checkIdle`, never while a reply runs) and when Orin quits. The runner exposes the built-in connection `orin-local` ("On this Mac"): ready when the engine is installed and a model is downloaded; its models are the library; `execute` calls `use()` before the OpenAI adapter, and the loading note goes into the reply's thinking text. Suggested replies are skipped for it, and the Overseer uses a local model only after it answered once or the user turned it on. The renderer part is `LocalModels.jsx` in Settings → Models; status and progress arrive on the `local` event.

## Adding a provider

- If the provider has an OpenAI-compatible endpoint, add a preset to `catalog.js` with `kind: 'openai'` and its `baseURL`. No other change is needed.
- For a new protocol, add an adapter with `run()` and `listModels()`, and add a branch in `runner.execute`.
- For a new CLI, add a preset with `kind: 'cli'`, then add its argv in `cli.command` and its event parsing in `cli.apply`.

## Context usage

Each saved assistant message can carry `usage: { used, window }`: the tokens of the last model call in the turn (input, cache, and output) and the context size. Claude Code reports both in its stream (`assistant` message usage, `result.modelUsage[].contextWindow`). Anthropic and OpenAI-compatible APIs report `used` (OpenAI-compatible servers get `stream_options.include_usage`, except Mistral). Codex and Copilot do not stream usage; after the turn `usage.js` reads the last `token_count` event of the Codex rollout file or the last `session.usage_record` of the Copilot session log. When the provider gives no size, the runner uses the Claude table in `usage.js`. For API and local models the composer shows the last message's usage as a ring.

## Plan limits

For CLI subscriptions the ring shows plan usage from `electron/limits.js`. Every source is free and costs no quota. Claude: `GET api.anthropic.com/api/oauth/usage` with the access token from the Keychain item `Claude Code-credentials` (read with `/usr/bin/security`). Orin never refreshes that token, because a refresh would replace Claude Code's refresh token; an expired token gives a "send a message with Claude Code" error. Codex: the newest `rate_limits` in `~/.codex/sessions` (`primary` is the 5-hour window, `secondary` the week; a window whose `resets_at` passed reads 0). Copilot: `gh api /copilot_internal/user` (`quota_snapshots`, monthly; quotas with entitlement 0 are left out). A reading is `{ plan, windows: [{ id, label, used, left?, total?, resetsAt }], note, at, error? }`; the first window is the session. `Limits` caches one reading per CLI for 60 s, shares a refresh that is running, keeps the last good numbers when a refresh fails, and reads again after each finished turn of that CLI (event `limits`). The renderer (`renderer/limits.js`) reads when a conversation opens and on hover, and warns once per window at 80% and 95% until the window resets. Smoke runs give fixed readings through `ORIN_LIMITS_FIXTURE`.

## Files

`electron/files.js` keeps each conversation's files under `<userData>/Files/<thread id>/`. Attachments are copied to `in/<uuid>/`, so a moved original does not break the chat. Files that API models make with `orin__write_file` go to `out/`. A file part is `{ type: 'file', name, path, size, mediaType }`; user messages hold attachments and replies hold made files. The renderer shows cards for file parts and for paths that CLI tools wrote (`Write`, `Edit`, Codex file changes, Copilot `create`/`edit`). Every file action goes through `Files.resolve`, which accepts only real paths inside the thread's folder or its workspace (symbolic links are resolved first). Attachment text comes from `extract.js` and goes into prompts as `<attachment>` blocks: through the transcript for API models, and in the stdin prompt with paths for CLI agents. Mermaid code blocks open as diagrams: `mermaid` loads on the first diagram, renders in strict mode (no scripts or click handlers), and takes its colors from the theme. Word, RTF, and OpenDocument output come from HTML through `textutil`; PDF output comes from Chromium's printer in a hidden window with scripts off.

## Voice input

The microphone button and ⌘⇧D drive `renderer/voice/voice.js`, which calls `voice:start`, `voice:stop`, and `voice:cancel`. Main (`electron/speech.js`) runs the helper `orin-speech`, built from `native/speech.swift` by `scripts/build-speech.cjs` (a universal binary in `dist/native/`, copied to `Contents/Resources` in packaged builds). The helper records the microphone with AVAudioEngine and runs `SFSpeechRecognizer` with `requiresOnDeviceRecognition`, so audio never leaves the Mac; a language without on-device support fails instead of using Apple's servers. It prints JSON lines (`ready`, `level`, `partial`, `final`, `error`) and reads `stop` or `cancel` on stdin. Partial text goes into the composer after the text that was there; Esc puts the composer back. The helper's permissions belong to the app that started it: macOS stops it with SIGABRT when that app has no `NSSpeechRecognitionUsageDescription`. Packaged builds get the key from `package.json`; the build script adds it to the development `Electron.app`. The renderer gets no device permissions. The locale is the Mac's locale when it is in the chosen language (en-GB stays en-GB), else a default region per language. Tests and smoke use `test/fixtures/fake-speech.cjs` (`ORIN_SPEECH_HELPER`).

## Commands, mentions, and suggestions

The composer opens a menu for `/` at the start of a message and for `@` before a word (`renderer/components/CommandMenu.jsx`). Orin's own commands (`/clear`, `/model`, `/effort`, `/access`, `/rename`, `/attach`, `/split`, `/skills`, `/changes`, `/settings`) run in the renderer for every model and never reach a model. `/clear` opens a new conversation with the same settings; the old one stays in the sidebar. File commands come from `commands.list`: Markdown templates in `~/.claude/commands`, `<workspace>/.claude/commands`, and `~/.codex/prompts`, and the skills of `skills.js`. Claude Code runs Claude commands and skills itself, so their `/name` text goes to it unchanged. For every other model `commands.expand` replaces the text with the template (`$ARGUMENTS`, `$1`…) or the skill's `SKILL.md` body, and saves it as the user message's `prompt`; the message still shows what the user typed. The `@` menu searches `git ls-files` (or a folder walk without dependency and build folders). On send, `commands.mentions` turns `@path` of a real file inside the workspace into a file part with `mention: true`. Its text is read in place (no `.text` cache in the user's folder) and goes to the model like an attachment.

Suggested replies show as chips above the composer and the first one as ghost text in the empty composer; Tab takes it. While the user types, `completion()` in `Composer.jsx` shows the rest of the first suggestion or earlier user message that starts with the typed text (a mirror div behind the transparent textarea); Tab or → takes it. Claude Code makes one itself (`--prompt-suggestions`) after its `result` event, so `runTurn` keeps reading stdout for up to 35 s after the turn ends and passes it to `onSuggestion`. `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` turns off Claude Code's server flag, near-limit, and unused-streak checks. With the `suggestReplies` preference, every provider, Claude Code too, makes up to three more with one extra short request: API models through `complete()`, CLIs through `cli.complete`, which runs once in the temporary folder with read-only access, low effort, and no saved session (`codex exec --ephemeral`).
