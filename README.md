# Orbit Code

A desktop workspace for Claude Code, Codex, and Gemini CLI. Built with Electron 40.3.0 so it can run on macOS 12 Monterey. Each agent runs through its installed CLI and uses that CLI's existing sign-in and local configuration.

## Run

```sh
npm install
npm start
```

Install and sign in to at least one provider CLI before starting a conversation. Open a project folder with **Add workspace**, choose an agent, and send a prompt. Choose a model from the dropdown and set effort with the slider. These choices persist per provider. Gemini CLI manages effort in its own configuration, so Orbit disables that slider for Gemini. Choose an access mode before running: provider default, read only, auto edits, or full access. Press **Enter** to send and **Shift+Enter** for a new line. Use **File → New Window** for another view.

## Features

- Multiple workspaces, conversations, and windows
- Live agent output and tool activity, with local conversation history
- Conversation branching from any earlier user message
- Local Git status, diffs, staging, commits, and a link to a GitHub origin remote
- Read-only list of skills found in the workspace and provider skill folders

## Current boundaries

Conversation branching replays earlier chat context into a new provider session. It does not revert files. Git operations use your existing local Git credentials. The GitHub integration opens the origin repository; pull requests, issues, and remote sync are not implemented yet. The default access selection is **Auto edits**. Provider default may deny actions that need an interactive approval prompt in this headless view. Full access bypasses provider approval and sandbox controls; the app asks before enabling it. The working folder is shown below the composer. macOS may still ask for folder access on first use. Provider CLI versions can change their stream formats, so integration may need updates.

Conversations are stored at Electron's `userData/orbit-data.json` with user-only file permissions. This includes prompt and response text. The app does not store provider credentials.

## Package

```sh
npm run package:mac
```

The app is unsigned. macOS may require a local security exception before opening a packaged build.
