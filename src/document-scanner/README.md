# Document Scanner

Open-source, browser-based document digitizer inspired by workflows in Adobe Scan / CamScanner / Microsoft Lens — **original implementation**, no proprietary assets.

## Features (v0)

- Open images or capture from the device camera
- Four-corner perspective correction (drag handles)
- Enhancement filters: document (local threshold), grayscale, contrast, hard threshold, original
- Multi-page session with remove
- Export a multi-page PDF (JPEG-embedded pages)

## Non-goals / limitations

- No automatic edge ML detector yet (manual quad)
- No on-device OCR in v0
- Camera requires user permission and HTTPS / localhost

## Development

Requires Node.js 22.12+.

```sh
npm install
npm run dev
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).

## Related

Upstream request: HeyPuter/everything#75
