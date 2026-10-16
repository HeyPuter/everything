# Downloader

A high-speed, modern download manager for [Puter](https://puter.com): chunked streaming fetch, real-time speed monitoring, category organization, pause/resume, and direct Puter Cloud Filesystem integration. Alternative to Internet Download Manager (IDM) and Free Download Manager (FDM).

No framework dependencies, built with vanilla ES modules, modern CSS, Puter.js v2, and Vite.

## Features

- **Puter Cloud Storage Integration:** Automatically streams and stores finished downloads directly into your Puter Cloud account under `/Downloads/`, accessible from Puter Desktop, Files app, and across all your devices.
- **Local Fallback Option:** Toggle between Puter Cloud storage (`/Downloads`) and instant direct-to-device browser downloads.
- **Streaming Transfer Engine:** Uses the Fetch Streams API (`ReadableStream` chunks) to monitor live transfer metrics, instantaneous bandwidth (KB/s, MB/s), progress percentages, and accurate estimated time of arrival (ETA).
- **Categorization & Filtering:** Automatically sorts downloads into Videos, Audio, Documents, Compressed Archives, Programs, and Images by MIME type or file extension.
- **URL Inspection & Probing:** Pre-inspects target URLs using `HEAD` requests to detect remote filenames and file sizes before initiating the download.
- **Task Management:** Pause active transfers, resume, retry failed requests, or remove history.
- **Quick Sample Testing:** Built-in 1-click verified sample files (audio, documents, logos, wallpapers) for immediate zero-friction testing.
- **State Persistence:** Preserves download history across browser restarts using Puter Cloud Key-Value store (`puter.kv`) with local fallback (`localStorage`).
- **Modern Glassmorphic UI:** Full dark/light/system theme support, responsive sidebar, pulsating bandwidth meter, and Lucide icons.

## Quick Start

```bash
cd src/downloader
npm install
npm run dev
```

Open `http://localhost:5178` to launch Downloader with the Puter localhost bridge.

## Testing

```bash
npm test
```

Runs comprehensive Vitest unit tests covering filename resolution, MIME category detection, speed/size formatting, and reactive task management.

## Building for Production

```bash
npm run build
```

Generates optimized, production-ready static assets in `dist/`.

## License

MIT
