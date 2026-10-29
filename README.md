<p align="center"><img src="docs/cover.png" alt="Hanobi" width="860"></p>

# Hanobi

Hanobi is a lightweight desktop harness for the language models you use. One window connects to three types of model source:

| Route | How it connects | Examples |
| --- | --- | --- |
| Subscription | Runs the official CLI with your existing sign-in. Hanobi never reads CLI tokens. | Claude Code (Claude Pro/Max), Codex (ChatGPT), GitHub Copilot, Gemini CLI |
| API key | Calls the provider API. Keys are encrypted with the macOS Keychain. | Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, Mistral, Groq, xAI Grok, GitHub Models, any OpenAI-compatible URL |
| Local | Calls a model server on this Mac. No key, no network. | Ollama, LM Studio |

Hanobi runs on macOS 12 Monterey and later, including Intel Macs. It pins Electron 40.3.0 to keep macOS 12 support.

## Features

- Conversations grouped by project folder, plus a general **Chats** folder.
- A model picker for every connected model. You can switch models in the middle of a conversation. A model from the same provider continues with the full native history. A model from a different provider gets a text transcript.
- Streaming Markdown replies, thought summaries, and expandable tool calls.
- MCP connectors over stdio or Streamable HTTP, including OAuth sign-in (for example, Notion). API and local models ask before each tool call, unless you choose **Allow tools**. Claude Code receives the connectors that do not use OAuth.
- Image attachments for API and local models.
- Branching: start a new branch from any of your messages, then edit and send it again.
- Git panel: status, diffs, stage, unstage, commit, and a link to the GitHub remote.
- A list of the skills that your CLI agents load.
- Light and dark themes that follow macOS, multiple windows, and keyboard shortcuts (`⌘N`, `⌘,`, `⌘\`).

## Run

```sh
npm install
npm start
```

Then open **Settings → Models**:

- **Subscriptions:** install a CLI (for example, `claude`) and sign in from Terminal. Hanobi finds it automatically. Click the rescan button after you install one.
- **API keys:** click **Add a provider**, choose a provider, and paste a key.
- **Local:** start Ollama or LM Studio, then add it. Hanobi lists the downloaded models.

GitHub Copilot needs its CLI: run `npm install -g @github/copilot`. It uses your GitHub sign-in (`gh auth login`). Each turn uses premium requests from your Copilot plan. Copilot loads its own MCP servers from `~/.copilot/mcp-config.json`.

Microsoft Copilot (the consumer app) has no API for other apps, so Hanobi cannot connect to it. Microsoft 365 Copilot has a preview Chat API, but only for work accounts with a Microsoft 365 Copilot license.

Gemini CLI does not serve personal Google AI plans now. Those accounts moved to Antigravity. To use Gemini with a personal account, add a **Google Gemini API** key.

## Access modes

| Mode | CLI agents | API and local models |
| --- | --- | --- |
| CLI rules | The CLI's saved permission rules. Requests that need an interactive prompt are denied. | n/a |
| Read only | Plan mode or read-only sandbox | n/a |
| Auto edits (default for CLIs) | File edits allowed. Other actions follow the CLI. | n/a |
| Ask first (default for APIs) | n/a | Hanobi asks before each MCP tool call |
| Full access / Allow tools | No approval and no sandbox. Hanobi asks you to confirm first. | Tools run without asking |

## Privacy and security

- Conversations are stored in `~/Library/Application Support/Hanobi/hanobi-data.json` with user-only file permissions.
- API keys, MCP environment values, headers, and OAuth tokens are stored in `hanobi-secrets.json`. Electron `safeStorage` encrypts them with the macOS Keychain. The renderer never receives these values.
- Prompts go only to the model you choose and to the MCP servers that you turn on.
- The renderer runs sandboxed with context isolation and a strict Content Security Policy. Links open in your browser.
- Data from Orbit Code (the earlier name) is copied over on first launch.

## Development

```sh
npm test            # unit and end-to-end tests (fake model servers, a real MCP server)
npm run smoke       # starts the real app with throwaway data and drives the UI
npm run icons       # renders build/icon.icns and docs/cover.png from their sources
npm run package:mac # unsigned DMG and ZIP in dist/release
```

`SMOKE_SHOTS=<folder> npm run smoke` saves light and dark screenshots. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the parts fit together.

The packaged app is unsigned. macOS may ask you to allow it in **System Settings → Privacy & Security**.

## Roadmap

1. Live verification of each subscription CLI and API provider on real accounts.
2. Structured approval prompts for CLI agents, instead of pre-set modes.
3. File checkpoints and rewind, aware of uncommitted Git changes.
4. GitHub pull requests, branches, and review status.
5. Project knowledge: attach files and folders to API conversations.
6. Signing, notarization, auto-update, a license, and contributor guidelines before a public release.
