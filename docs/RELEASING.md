# Releasing Orin

## Unsigned builds

`npm run package:mac` makes a DMG and a ZIP in `dist/release`. When no Developer ID certificate is in the Keychain, electron-builder skips signing and notarization. macOS then asks users to allow the app in **System Settings → Privacy & Security**.

## Signed and notarized builds

Signing needs a paid Apple Developer Program membership.

1. In Xcode or on developer.apple.com, make a **Developer ID Application** certificate. Install it in your login Keychain.
2. Make an App Store Connect API key with the **Developer** role. Download the `.p8` file once and keep it outside the repository.
3. Set these environment variables in your shell. Do not commit them:

   ```sh
   export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
   export APPLE_API_KEY_ID=XXXXXXXXXX
   export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

4. Run `npm run package:mac:release`.

The release script sets `forceCodeSigning`, so it fails if it cannot find the certificate. It never makes an unsigned release by mistake. electron-builder signs with the hardened runtime, then sends the app to Apple's notary service through `notarytool` and staples the ticket.

Check the result:

```sh
codesign --verify --deep --strict --verbose=2 dist/release/mac/Orin.app
spctl --assess --type execute --verbose dist/release/mac/Orin.app
```

`spctl` must say `accepted` and `source=Notarized Developer ID`.

## Publish

1. Change `version` in `package.json` and commit.
2. Tag the commit and push the tag: `git tag v<version>` and `git push --tags`.
3. The `Release` workflow (`.github/workflows/release.yml`) runs the tests, builds unsigned DMG and ZIP files for Intel and Apple Silicon, and makes the GitHub release.

Orin's update check reads the latest release through the GitHub API without a token. It works only when the repository is public. A private repository answers 404, and Settings shows "No public release yet". GitHub Actions on a private repository uses the free monthly minutes. A macOS minute counts as ten.

## Updates without signing

Squirrel.Mac (the macOS auto-updater) installs updates only for signed apps. Orin is free and unsigned, so it checks GitHub Releases once a day and links to a newer release. From source, `git pull` and `npm run install:mac` update the installed app.
