# Tabkept

A Chrome extension that saves every window, tab and tab group as you work, writes hourly backup files to your Downloads folder, and restores them with their groups. No account, no server, no analytics: it makes no network requests of its own.

- Homepage: https://publishingworks9.github.io/tabkept/
- Privacy policy: https://publishingworks9.github.io/tabkept/privacy.html
- Source: [`extension/`](extension/), the exact files in the Chrome Web Store package.

## What it does

- Saves a couple of seconds after any change: windows, tabs, pins, tab groups (name, colour, collapsed), window positions.
- Keeps a timeline (every save for 24 hours, hourly for 7 days, daily for 90 days) and named sessions that are never thinned out.
- Writes a JSON backup and a page of links to `Downloads/Tabkept` every hour, and an extra backup before every update.
- Restores a session, a window, a group or ticked tabs; restored tabs open asleep (Chrome's own tab discarding) and load when clicked.
- Puts everything it closes in a 30-day bin.
- Imports exported session files (JSON), CSV, link lists, Chrome bookmark files and its own backups.

## Load it from source

1. Download this repository and open `chrome://extensions`.
2. Turn on Developer mode, click "Load unpacked" and pick the `extension` folder.

## How it is built

Manifest V3, plain JavaScript modules, no dependencies and no build step. The service worker (`sw.js`) holds nothing important in memory; every save is an IndexedDB transaction (`lib/db.js`). Pure logic (snapshots, retention, duplicates, importers) lives in `lib/core.js` and `lib/import.js`.

## Licence

MIT. See [LICENSE](LICENSE).
