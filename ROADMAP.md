# Orbit Code continuation guide

## Goal

Build a desktop coding-agent workspace that runs on a 2017 Intel Mac with macOS 12. The user wants the readability, responsive history, and thread management of a desktop app while using existing Claude Code, Codex, and other provider accounts. Longer-term goals include GitHub integration, safe conversation and file rewind, skills, multiple workspaces, and multiple windows. The repository is currently a functional prototype and is private until the user decides to open source it.

## Current implementation

- Electron 40.3.0, macOS 12 minimum, Intel DMG and ZIP build through `npm run package:mac`.
- Uses installed provider CLIs and their existing authentication. Claude and Codex sign-ins were detected on the development Mac; provider requests were not live-tested across all modes.
- Workspaces, threads, conversation history, branching, model choice, and access settings saved locally in Electron userData.
- Claude, Codex, Gemini adapters use JSON event streams. Claude partial text events render during a run.
- Provider-specific model menus; persistent model and access settings; effort slider for Claude and Codex. Gemini CLI does not expose a simple per-run effort flag, so its slider is disabled.
- Access modes: provider default, read only, auto edits, full access. Full access is marked and requires confirmation in the UI.
- Enter sends, Shift+Enter adds a line. Activity panel has a spinner.
- Local Git status, diffs, staging, commits, and open-GitHub-origin action.
- Local skill discovery; multiple windows.
- macOS purpose strings explain Downloads, Documents, and Desktop access. The system permission dialog remains mandatory when macOS requires it.

## Known boundaries

- Conversation branching replays prior chat context; it does not restore files. Design file rewind carefully around dirty Git worktrees.
- Some provider actions require interactive approval; the current headless CLI bridge may deny them in provider-default mode.
- Gemini CLI no longer serves individual Google AI Pro/Ultra accounts; those moved to Antigravity CLI. Existing Gemini adapter is useful for enterprise/API-key access.
- The model lists are a snapshot; account-specific availability and model aliases should eventually come from provider capabilities.
- No native account connection UI, pull-request integration, signed/notarized app, update channel, or custom app icon yet.
- Long conversations render recent messages first and can load older messages, but scrolling performance has not been benchmarked on the user's machine.

## Next useful milestones

1. Live-test Claude Opus 5.5 on the user's existing Claude Pro CLI login, plus Codex, without exposing account tokens.
2. Improve provider bridge and permissions: structured approval requests in the desktop UI and clear command/file previews.
3. Add Antigravity support for personal Google subscriptions and remove or relabel Gemini CLI where access is unavailable.
4. Implement safe file checkpoints/rewind with Git awareness and explicit handling of pre-existing edits.
5. Add GitHub pull requests, branches, and review status; polish thread navigation and rendering with large histories.
6. Prepare for open source: license, security review, signing/notarization, release automation, and contributor documentation.

## Commands

```sh
npm install
npm test
./node_modules/.bin/electron scripts/smoke.cjs
npm start
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

The generated `dist/` and `node_modules/` directories are intentionally ignored by Git. Local conversation data is stored under Electron's userData directory and is not part of this repository.
