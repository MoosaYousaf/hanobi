# Orin

Desktop harness for any LLM (CLI subscriptions, API keys, local models, MCP). Electron 40.3.0 (pinned for macOS 12) + React/Vite renderer. Read `docs/ARCHITECTURE.md` first.

## Commands

```sh
npm start            # build renderer, open "Orin Dev" (own data folder; runs next to the installed app)
npm test             # node --test test/*.test.js (fake model servers + a real stdio MCP server)
npm run smoke        # real app, throwaway data; SMOKE_SHOTS=<dir> saves light/dark screenshots
npm run icons        # build/icon.svg -> icon.icns/png, docs/cover.html -> cover.png
npm run package:mac  # DMG/ZIP in dist/release (unsigned without a Developer ID cert)
npm run package:mac:release  # signed + notarized; see docs/RELEASING.md
npm run install:mac  # build, ad-hoc sign, install in /Applications (the user's daily app)
```

## Rules

- All data, secrets, model calls, and tools stay in `electron/`. The renderer only displays state and invokes IPC handlers listed in `electron/main.js`.
- `electron/draft.js` is the only stream reducer. Adapters write parts into it.
- CLI prompts go through stdin, never argv.
- Secrets go through `electron/secrets.js` (Keychain via safeStorage). Never send them to the renderer or commit them.
- Monochrome theme: true black (dark, the default) and white (light). The accent is the strongest contrast (white on black, black on white) and is only for the primary action, the live state, selection, and the mark. Color only for meaning (danger, success, warning, code). No decorative cards.
- Live tests on the user's CLI accounts cost real quota (Copilot premium requests). Ask before you run more of them.
