# Aegis Security desktop

Antivirus for Windows and macOS: on-demand scans, real-time protection of
Downloads, Desktop and Documents, removable drive scanning, quarantine and
signed threat definitions. Built with Electron and React.

## Download

Get the latest installers from the [Releases](../../releases/latest) page.

- **Windows 10/11 (64-bit):** `Aegis-Setup.exe`
- **macOS 11 or later (Intel and Apple silicon):** `Aegis-<version>-mac.dmg`.
  Open it and drag Aegis to Applications. The first time, open **System
  Settings → Privacy & Security** and click **Open Anyway** next to Aegis.

A licence key is required to turn protection on.

## Develop

```bash
npm install
cp .env.example .env   # local API URL and public keys
npm run dev
```

See [RELEASING.md](RELEASING.md) for building installers.
