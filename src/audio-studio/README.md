# Audio Studio

**Live app:** [as.puter.com](https://as.puter.com/)

A waveform and multitrack audio editor for the browser, built on [Puter](https://puter.com). Record, edit, restore, mix and master audio with a docked panel workspace, studio effects and spectral editing. Audio is processed on your device; projects and exported files are stored in your own Puter cloud.

An open-source alternative to Adobe Audition. No framework: vanilla JavaScript modules built with Vite. Puter.js is the only backend.

## What it does

- **Waveform editor**: sample-accurate editing with five clipboards, zero-crossing adjustment, markers (cue, range, subclip, cart, CD) edited in place, spectral frequency and pitch displays with marquee, lasso, brush and healing tools, and a Preview Editor that shows an effect's result before it is applied.
- **Multitrack editor**: clips with fades, crossfades, envelopes, groups, stretching, remixing to a new length and speech alignment; buses, eight sends per track, track EQ and effect chains; automation; punch-in and loop recording into takes; mixdowns and bounces; session templates.
- **Effects**: amplitude, delay, filter and EQ, modulation, restoration (noise prints, sound models, click/pop elimination, hum, reverb and hiss removal), reverb, special and time/pitch processors, all in WebAssembly, usable live in the Effects Rack and track chains or applied to a selection, with presets and Favorites.
- **Analysis**: frequency analysis, amplitude statistics, phase meter, loudness measurement and matching, diagnostics.
- **Workspace**: docked panels (Files, Media Browser for Puter and folders on this device, Markers, Playlist, Mixer, Tracks, Track Panner, Time, Zoom, Transport, Tools, Events, Video...) arranged in saved workspaces; categorized Preferences; MIDI control surfaces; batch processing; JavaScript automation scripts.

## Architecture

| Area | Where | Notes |
| --- | --- | --- |
| Sample storage | `src/audio/channel.js` | Immutable channels made of references into shared, never-mutated `Float32Array` blocks. Cut, paste and delete only rearrange references, so undo snapshots are nearly free and long files edit without copying. |
| Documents | `src/model/` | `AudioFile` (waveform editor) with an undo `History` of immutable states; pure edit functions in `edits.js`; markers. |
| DSP | `wasm/dsp` (Rust) built to `src/audio/dsp.wasm` | FFT, spectrogram columns, peaks, statistics, resampling and the effect processors, called through a plain C ABI. The built file is committed, so the app builds without Rust. |
| Playback | `src/engine/` | One AudioWorklet mixes every track (gain, pan, envelopes, WASM effect chains). The main thread streams only the sample chunks near the playhead to the worklet. `mixcore.js` is shared with offline rendering. |
| Drawing | `src/render/` | WebGL2 waveform renderer (instanced min/max columns, sample lines when zoomed in) with a Canvas 2D fallback; peak levels cached per block. |
| UI | `src/ui/`, `src/panels/`, `src/editor/` | Command registry drives menus, shortcuts and buttons; docked panels with workspaces; responsive layouts for desktop, tablet and phone. |
| Video | `src/video/`, `src/model/session-video.js` | A session's video track: the picture of an inserted video file as a thumbnail strip above the tracks, and the Video panel, a muted `<video>` kept in step with the playhead. Mixdowns ignore it. |
| Features | `src/features.js` | Feature modules register commands, panels and document kinds. |
| Commands | `src/commands/`, `src/multitrack/commands.js` | Menu commands by area (core, edit, file, view, help, scripts). |
| Multitrack | `src/multitrack/`, `src/model/session*.js` | Session model and edits, graph building (routing, sends, EQ), recording, stretching, alignment, templates. |
| Hardware | `src/control-surface/` | Web MIDI control surfaces: a DAW-controller protocol and learned mappings. |

## Development

```sh
npm install
npm run dev        # http://127.0.0.1:5621/
npm test           # vitest
npm run build      # checks dependency licenses, then builds to dist/
npm run build:wasm # rebuilds src/audio/dsp.wasm (needs Rust 1.85.1 with wasm32-unknown-unknown)
```

In development, `window.as` is the app and `as.openDev(['name.wav'])` opens test files from the gitignored `.dev-media/` folder.

## Third-party

- [Lucide](https://lucide.dev) icons (ISC), plus original glyphs in `src/ui/icons.js`.
- [Puter.js](https://docs.puter.com) for sign-in, cloud files and AI features.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
