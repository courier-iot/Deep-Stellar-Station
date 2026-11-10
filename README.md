# ✦ Deep Stellar Station

The desktop sibling of **[Deep Stellar Browsing](https://github.com/courier-iot/Deep-Stellar-Browser)** for Linux and Windows: a private, deep-space browser that **links with Deep Stellar Browsing on Android**. Scan a QR code once, then send pages and notes between your phone and computer, end-to-end encrypted, with no server and no account.

## Features (version 0.1)

| | |
|---|---|
| **No history** | Every tab is a private (incognito) view: no history, cookies or cache survive closing it. |
| **Ad & tracker shield** | A built-in local proxy refuses connections to ad and tracker domains (bundled list, plus the StevenBlack hosts list with one click). For HTTPS it only sees which site is contacted, never the content. |
| **Privacy defaults** | HTTPS-only, tracking tags stripped from links, click-through redirects skipped, WebRTC limited to relays (no IP leaks), Global Privacy Control. |
| **Search** | DuckDuckGo, DuckDuckGo Lite, Brave, Startpage, Mojeek or your own; search shortcuts `!gh`, `!w`, `!aw`, `!yt`, `!crates` … resolved on the computer. |
| **Tabs** | Tab strip, Ctrl+T / Ctrl+W / Ctrl+Shift+T / Ctrl+Tab / Ctrl+L, reopen closed tabs (memory only). |
| **Starfield start page & themes** | The same start page and four themes as the phone: Nebula, Event Horizon, Supernova, Aurora. |
| **Bookmarks** | Import/export in the standard bookmark file every browser uses (folders kept). |
| **Downloads** | Saved to `Downloads/DeepStellar`; the list is memory only. |
| **Link with your phone** | Side panel → **Link a phone** → scan with Deep Stellar Browsing. Send the current page or a note either way; messages wait until the other device is back on the same Wi-Fi. |

## Linking: how it works

Needs Deep Stellar Browsing with **Linked computers** in its menu (the release after this one adds it). Same network only in this version. The computer advertises itself on your network (mDNS) and the phone connects directly. Pairing swaps keys through the QR code; after that, every message is encrypted with AES-256-GCM using a key only the two devices hold (ECDH P-256 + HKDF). The full specification is in [docs/LINK-PROTOCOL.md](docs/LINK-PROTOCOL.md). Next: reaching your computer from anywhere through Tor onion services, still with no relay server.

## Install

Download from the [latest release](../../releases/latest):
- **Linux:** `…amd64.AppImage` (make it executable and run it) or `…amd64.deb` (`sudo apt install ./file.deb`). Needs WebKitGTK 4.1, which current Ubuntu, Debian, Mint and Pop!_OS have.
- **Windows 10/11:** `…x64-setup.exe`. Windows may show a SmartScreen warning because the installer isn't code-signed (that certificate costs money every year); choose *More info → Run anyway*.

Each release lists the SHA-256 of every file.

## Build it

Push to GitHub: the **Build Station** workflow builds Linux and Windows, and a `v*` tag publishes a release. Locally: install Rust and Node, plus on Linux `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`, then:

```bash
npm install
npx tauri dev     # run
npx tauri build   # installers in src-tauri/target/release/bundle
```

## Layout

```
src-tauri/src/main.rs     window, tabs (one private web view each), downloads, commands
src-tauri/src/proxy.rs    the shield proxy
src-tauri/src/link.rs     linking transport: TCP listener, mDNS, frames
src-tauri/src/store.rs    the few small files Station keeps (settings, bookmarks, linked devices, shared items)
src-tauri/src/tab-init.js runs in every tab: same-tab pop-ups, WebRTC relay-only, GPC
ui/                       toolbar (index.html, app.js, style.css), link.js (pairing + encryption), start page
docs/LINK-PROTOCOL.md     the link protocol both apps implement
```

## Honest limits (0.1)

- Pages render with the system engine: WebView2 (Chromium) on Windows, WebKitGTK on Linux, so a few sites may look slightly different between the two.
- Keyboard shortcuts work when the toolbar has focus; click the address bar first if a page is holding the keyboard.
- Tab names show the site's address rather than the page title.
- Torrents, the learning ad shield, the inspector and backups are in the Android app only for now.
- Linked-device keys are stored in Station's data folder, readable only by your user account on Linux.

## License

MIT.
