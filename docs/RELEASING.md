# Releasing Hanobi

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
codesign --verify --deep --strict --verbose=2 dist/release/mac/Hanobi.app
spctl --assess --type execute --verbose dist/release/mac/Hanobi.app
```

`spctl` must say `accepted` and `source=Notarized Developer ID`.

## Publish

1. Change `version` in `package.json` and commit.
2. Tag the commit: `git tag v<version>` and `git push --tags`.
3. Make a GitHub release for the tag. Attach the DMG and the ZIP from `dist/release`.

## Auto-update

Auto-update is not built yet. On macOS, Squirrel.Mac updates only signed apps, so it waits for a Developer ID certificate. The plan is `electron-updater` with GitHub Releases as the feed. The ZIP is the update file and the DMG is for first installs.
