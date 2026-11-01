# Downloader

A high-speed, modern download manager for [Puter](https://puter.com): chunked streaming fetch, real-time bandwidth graph, category organization, pause/resume, and direct Puter Cloud Filesystem integration. Alternative to Internet Download Manager (IDM) and Free Download Manager (FDM).

No framework dependencies, built with vanilla ES modules, modern CSS, Puter.js v2 SDK, and Vite.

## Features

- **Puter Cloud Storage Integration:** Automatically streams and stores finished downloads directly into your Puter Cloud account under `/Downloads/`, accessible from Puter Desktop, Files app, and across all your devices.
- **Puter Account & Authentication:** Connects with Puter User accounts to sync download tasks across sessions and open `/Downloads` in the Puter Files app in one click.
- **Streaming Transfer Engine:** Uses the Fetch Streams API (`ReadableStream` chunks) to monitor live transfer metrics, instantaneous bandwidth (KB/s, MB/s), progress percentages, and dynamic estimated time of arrival (ETA).
- **Live Bandwidth Sparkline Graph:** Real-time canvas throughput visualizer showing transfer speed curves over time (IDM / Task Manager style).
- **Download Inspector Drawer:** Slide-out detail inspector showing full URLs, MIME types, duration, average speeds, remote headers, and cloud paths.
- **Batch Downloads (Multi-URL):** Queue and fetch multiple links simultaneously from a single paste-list.
- **Drag-and-Drop Links:** Drag any URL or download link onto the window to automatically inspect and queue downloads.
- **Notification Chimes:** Subtle Web Audio API completion sound notification when downloads finish (zero external audio files required, toggleable in settings).
- **Offline PWA Support:** Built-in Service Worker caching (`sw.template.js`) providing offline shell execution and Puter SDK caching.
- **Categorization & Filtering:** Automatically classifies downloads into Videos, Audio, Documents, Compressed Archives, Programs, and Images by MIME type or file extension.
- **URL Inspection & Probing:** Pre-inspects target URLs using `HEAD` requests to detect remote filenames and file sizes before initiating the download.
- **Keyboard Shortcuts:**
  - `N`: Open New Download dialog
  - `/`: Focus search bar
  - `Esc`: Close modals and detail drawers
  - `Ctrl+D`: Toggle Dark / Light theme
- **State Persistence:** Preserves download history across browser restarts using Puter Cloud Key-Value store (`puter.kv`) with local fallback (`localStorage`).
- **Modern Glassmorphic UI:** Full dark/light/system theme support, responsive sidebar, pulsating bandwidth meter, and Lucide icons.

## Quick Start

```bash
cd src/downloader
npm install
npm run dev
```

Open `http://127.0.0.1:3000/` or `http://downloader.puter.localhost:3000/` to launch Downloader.

## Testing

```bash
npm test
```

Runs comprehensive Vitest unit tests covering filename resolution, MIME category detection, speed/size formatting, batch additions, and reactive store management (17 tests, 100% pass).

## Building for Production

```bash
npm run build
```

Generates optimized, production-ready static assets in `dist/` with auto-versioned `sw.js` service worker.

## License

MIT
