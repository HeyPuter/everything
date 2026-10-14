# Music Studio

A pattern-based music production workstation for the browser, built on [Puter](https://puter.com). Program beats in the channel rack, write melodies and chords in the piano roll, arrange patterns, audio and automation in the playlist, and mix with studio effects. An open-source alternative to FL Studio.

No framework: vanilla JavaScript modules built with Vite. The audio engine is written in Rust and compiled to WebAssembly. Puter.js is the only backend.

> Early alpha. Features will change and projects could be lost. Don't use it for serious work yet.

## What it does

- **Channel rack**: a step sequencer with per-channel mute, solo, volume, pan and mixer routing, plus instrument editors for each channel.
- **Instruments**: a polyphonic subtractive synthesizer, a drum synthesizer (kick, snare, clap, hats, toms, percussion) and a sampler for your own audio. Every bundled sound is synthesized; no audio files ship with the app.
- **Piano roll**: draw, paint, slice, select and audition tools, velocity and pan lanes, ghost notes, scale highlighting, quantize, chords and a riff generator.
- **Playlist**: arrange pattern, audio and automation clips on tracks, with a loop region, markers and slicing. Automation curves have per-segment tension, and a tempo lane can ramp or step the tempo.
- **Mixer**: inserts with peak meters, faders, pan, stereo width, sends and up to ten effects per insert (parametric EQ, compressor, limiter, delay, reverb, chorus, phaser, oversampled distortion, bitcrusher, filter, stereo tool), each with built-in presets and your own saved presets.
- **Recording**: play from the computer keyboard or a MIDI controller, record into patterns, step edit.
- **Files**: works without signing in (projects autosave on this device, separately for each open tab). Signed in, projects, samples, exports and your presets save to the app's own folder in your Puter cloud. Import audio and MIDI; export WAV, MIDI and stems.
- **Everywhere**: dark, light and system themes; desktop, tablet and phone layouts; full keyboard operation.

## Architecture

| Area | Where | Notes |
| --- | --- | --- |
| Model | `src/model/` | The project is plain JSON treated as immutable: edits return a new project that shares unchanged parts, so undo keeps references, not copies. `store.js` holds the history and the view state. |
| Parameters | `src/instruments/catalog.js`, `src/effects/catalog.js` | Instrument and effect parameter definitions shared by the editors, automation and the engine. |
| Engine | `src/engine/`, `wasm/engine/` (Rust) | One AudioWorklet runs the WebAssembly engine: sample-accurate sequencing, instruments, mixer routing and effects. The built `engine.wasm` is committed, so the app builds without Rust. Offline rendering runs the same core in a worker. |
| Editors | `src/panels/`, `src/rack/`, `src/pianoroll/`, `src/playlist/`, `src/mixer/` | Editor surfaces draw with a WebGL2 instanced-rectangle renderer (`src/render/gfx.js`) with a Canvas 2D fallback. |
| UI | `src/ui/`, `src/commands/` | A command registry drives menus, shortcuts and toolbar buttons; docked panels and floating editor windows. |
| Storage | `src/storage/`, `src/io/` | Local drafts in IndexedDB, Puter cloud files when signed in, WAV and MIDI encoders and decoders. |

## Development

```sh
npm install
npm run dev        # http://music-studio.puter.localhost:5641/
npm test           # vitest
npm run build      # checks dependency licenses, then builds to dist/
npm run build:wasm # rebuilds src/engine/engine.wasm (needs Rust 1.85.1 with wasm32-unknown-unknown)
```

In development, `window.ms` is the app.

## Third-party

- [Lucide](https://lucide.dev) icons (ISC), plus original glyphs in `src/ui/icons.js`.
- [Puter.js](https://docs.puter.com) for sign-in and cloud files.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
