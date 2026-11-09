# Contributing to Orin

Thank you for your help. This file tells you how to set up, change, and test Orin.

## Set up

1. Install Node.js 22 or later.
2. Clone the repository and install the packages:

   ```sh
   git clone https://github.com/MoosaYousaf/orin.git
   cd orin
   npm install
   ```

3. Start the app with `npm start`.

Orin runs on macOS 12 and later. Electron is pinned to 40.3.0 because later versions do not support macOS 12. Do not update Electron.

## Read first

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). It tells you where each part is and how data moves.

## Rules

- Keep data, secrets, model calls, and tools in `electron/`. The renderer only shows state and calls the IPC handlers in `electron/main.js`.
- `electron/draft.js` is the only stream reducer. Adapters write parts into it.
- Send CLI prompts through stdin. Never put prompt text in argv.
- Store secrets only through `electron/secrets.js`. Never send a secret to the renderer. Never commit a secret.
- The theme is monochrome. Use the accent (white in dark mode, black in light mode) only for the primary action, the live state, the selection, and the mark.
- Do not add a dependency when Node.js, Electron, or a macOS tool can do the work.
- Match the code around your change: its names, its comment density, and its idioms.

## Test

Run both commands before you open a pull request:

```sh
npm test        # unit and end-to-end tests with fake model servers, a fake gh, and a real MCP server
npm run smoke   # starts the real app with throwaway data and drives the UI
```

`SMOKE_SHOTS=<folder> npm run smoke` saves light and dark screenshots. Look at them when you change the UI.

The tests use fake CLIs in `test/fixtures/`. They do not use your accounts. A live test on a real CLI or API account uses your quota. Tell us in the pull request which live tests you ran.

## Pull requests

1. Make a branch from `main`.
2. Keep one change in one pull request.
3. Add or change a test for each behavior that you change.
4. Update `README.md` and `docs/ARCHITECTURE.md` when the behavior or the structure changes.
5. Write what changed, why, and how you tested it.

## Report a problem

Open an issue on GitHub. Include the macOS version, the Orin version, the provider, and the steps to see the problem. Remove keys, tokens, and private text from logs before you attach them.

Report a security problem privately through GitHub's **Report a vulnerability** form on the Security tab. Do not open a public issue for it.

## License

You agree that your contributions are licensed under the [MIT License](LICENSE).
