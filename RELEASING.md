# Releasing Aegis

Installers are built on GitHub's machines by `.github/workflows/release.yml`:
Windows (`Aegis-Setup.exe`) on `windows-latest`, macOS (`Aegis-<version>-mac.dmg`,
one universal file for Intel and Apple silicon) on `macos-latest`. A macOS
build cannot be made on Windows.

## Cut a release

1. Bump `version` in `package.json` (and `package-lock.json`). Never rebuild a
   version that is already published.
2. Commit and push, then tag the same version:

   ```bash
   git tag v1.2.1
   git push origin main v1.2.1
   ```

3. Wait for the **Build installers** workflow (Actions tab, about 10 minutes).
   It creates the GitHub release with both installers and `SHA256SUMS.txt`.
4. Update the website's `src/config/downloadConfig.js` with the new version,
   sizes and SHA-256 values from `SHA256SUMS.txt`.

## What gets baked in

`.env.production` holds the live API URL and the two PUBLIC verification keys.
Vite injects them at build time. They must match the private keys on the
backend (Vercel); if the backend keys change, update this file and release a
new version. Private keys never belong in this repository.

For local development, `npm run dev` reads `.env` instead (not committed; copy
`.env.example`).

## macOS signing

Builds are ad-hoc signed, not signed with an Apple Developer ID, so on first
launch macOS asks the user to allow the app in System Settings → Privacy &
Security → Open Anyway. With a paid Apple Developer account, add the
certificate and notarization secrets and replace `"identity": "-"` in
`package.json` to remove that step.
