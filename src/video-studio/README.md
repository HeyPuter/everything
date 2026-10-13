# Video Studio

A multi-track video editor that runs in the browser, an open-source alternative to CapCut: trim and arrange clips on a timeline, add text, graphics, effects, filters, transitions and keyframed motion, generate captions, remove backgrounds, and export finished videos. Projects and media are stored as files in the user's own Puter cloud.

The editor has an assets panel, the player and a details panel on top, the timeline below. On phones it switches to a player, timeline and bottom toolbar with sheets.

## Features

- **Media**: import video, audio and images from the device or from Puter; record the camera or the screen (with a teleprompter); generated backdrops; bins; drag to the timeline or the player; relink, reveal and clean up unused media.
- **Timelines**: a project can hold several timelines that share its media, each with its own shape, resolution and frame rate (a long cut, its shorts, a vertical version); switch from the menu above the player or the Timelines list in the media panel, duplicate one to try an alternative edit, or insert one into another as a compound clip.
- **Timeline**: base track with ripple editing, overlay video, text, effect, filter, color layer and audio tracks; drag between tracks; trim handles with frame preview; split (Ctrl/Cmd+B and split tool), delete left/right of the playhead (Q/W), copy, cut, paste, duplicate; copy and paste attributes; clip presets (save a clip's look and apply it anywhere); snapping with guides; overlays that move with the base clip under them; hover preview; markers with notes; in and out range; marquee selection; groups, labels and disabled clips; compound clips you can open and edit; multi-camera clips (angles lined up by sound, switch angles live with 1-9, flatten when done); track rename, reorder, solo, size, lock, hide and mute; a keyframe lane (Shift+K); an undo history panel; zoom with pinch or Ctrl/Cmd+wheel.
- **Clip tools**: speed (0.1x to 100x) and speed curves, smooth slow motion (frame blending or optical flow), reverse, freeze frame, detach audio, replace, mirror, rotate, crop, masks with feather and invert, chroma key, automatic background removal for people (with a brush to fix the result), people retouch (skin: smooth, even tone, brighten, sharpen, blemishes, dark circles, whiten teeth, lip color; face shape: slimmer face, eye size, slimmer nose, smile, chin length; hair color), motion blur, noise reduction, relight, canvas fill (color, gradient or blur), blend modes, opacity.
- **Smart tools** (all run on the device): split at scene changes, remove silences, sync two recordings by their sound, auto reframe to another aspect ratio, stabilize, remove flicker, track motion so text or stickers follow an object, extract a clip's sound as an audio file, and remove the background behind people.
- **Color**: basic, light and detail adjustments with keyframes, color on the whole clip, only on people or only on the background, masks that limit color, match color to another clip, HSL ranges, curves, color wheels, .cube LUTs, 48 filters with intensity.
- **Motion**: keyframes for position, scale, rotation, opacity and volume with easing presets (smooth, overshoot, elastic, bounce and more) or a custom curve; 41 in, out and loop animations.
- **Text**: styled presets, word art, speech bubbles, 13 bundled open fonts, stroke, background, shadow, per-letter animations, text templates, write with AI, text to speech.
- **Effects and transitions**: 89 effects (including 10 body effects that follow the people in a shot: outline, aura, neon edge, background blur, color spotlight, spotlight, cast shadow, clones, silhouette, hide person), 56 transitions and 48 filters, all original GLSL shaders, previewed live on hover. Effects go on their own track or stack (up to five) on a single clip.
- **Audio**: waveforms, volume, fades and loudness normalization, noise reduction, voice enhancement, separate voice and music, voice changer presets, channel routing and pan, generated music and sound effects, voiceover recording with a teleprompter.
- **AI creation**: script to video (write or generate a script, then narrated scenes with generated pictures, gentle motion, crossfades, captions timed to the voice and ducked music) and find highlights (pick the best self-contained moments of a long talk and turn them into shorts, reframed and captioned).
- **Captions**: automatic captions from speech, 12 caption styles (word pop, sing-along sweep and more), highlighted key words (picked on the device or with AI, or by hand), translation, SRT and VTT import and export, an editable captions list, find and replace across captions and titles (Ctrl/Cmd+F), dubbing into another language (translated, spoken and timed to the original speech, with the original sound lowered or muted), and transcript editing (delete words to cut the video).
- **Player**: zoom and pan, rulers, guides, snapping, safe zones, loop and play range, snapshots to the media library.
- **Export**: any of the project's timelines; H.264, HEVC, VP9 and AV1 where the browser can encode them; MP4, WebM and MOV; animated GIF; still frames; the whole project, the in/out range or the selection; 480p to 4K; 24 to 60 fps; audio only as WAV, M4A or OGG; captions as SRT; saved to the device or to Puter.
- **Share for review**: send a 720p review copy of the project or its in/out range to people with a Puter account through an invite link (can comment or can view, with expiry); they comment on exact frames or short ranges, reply and resolve on a focused review page; every new share adds a version; the owner sees the comments in the editor and jumps to them. See [docs/review.md](docs/review.md).
- Autosave, undo and redo, project gallery with thumbnails, light, dark and system themes, layout presets, customizable keyboard shortcuts, preferences, screen reader labels.
- Home screen with ten original project templates (generated backdrops, placeholder slots, text, motion and sound effects), a Trash with restore and a 30 day purge, and portable project files (a ZIP with the project and its media) for backup and moving work between accounts.

## How it works

| Area | Technology |
| --- | --- |
| Preview compositing, grading, effects, transitions | WebGL2 (`src/engine/compositor.js`, `src/engine/shaders.js`) |
| Preview decoding | Hardware-decoded media elements, with exact WebCodecs frames while they load or seek |
| Thumbnails and waveforms | WebCodecs in a Web Worker (`src/workers/media-worker.js`) |
| Export | Frame-exact WebCodecs decode and encode via [Mediabunny](https://mediabunny.dev) (MPL-2.0) |
| Background removal | Person segmentation on the device with the MediaPipe Tasks runtime and selfie segmenter model (Apache-2.0), loaded the first time it is used (`src/media/segmenter.js`, `src/engine/cutout.js`) |
| Face and hair retouch | Face landmarks (MediaPipe face landmarker) and hair segmentation (MediaPipe hair segmenter) on the device, each loaded the first time a tool needs it; landmarks are steadied between frames and drive a local warp, skin fix masks and the hair search area in the layer shader (`src/media/face-landmarks.js`, `src/media/hair-segmenter.js`, `src/engine/face-render.js`, `src/engine/face-geometry.js`) |
| Audio sample math (peaks, mixing, resampling, limiting) | Rust compiled to WebAssembly with SIMD (`wasm/dsp`, built into `src/media/dsp.wasm`) |
| Storage | Puter file system (`video-studio/` in the app's folder), OPFS cache; OPFS only when signed out |
| Review sharing | A small Puter worker the app deploys to the owner's account (`worker/`), with data in the owner's KV and videos in their files |
| UI | Plain JavaScript modules, no framework |

The project document (`src/model/project.js`) is plain JSON with times in integer microseconds. Timeline edits are pure functions (`src/model/timeline.js`) applied through an undoable store (`src/model/store.js`). `src/engine/scene.js` evaluates what is visible and audible at any time, and both the player and the exporter render from it.

## Development

```sh
npm install
npm run dev        # http://127.0.0.1:5517/  (add ?local to skip Puter sign-in and store in the browser)
npm test           # vitest unit and integration tests
npm run build      # production build into dist/ (bundles the review worker first)
npm run build:wasm # rebuild src/media/dsp.wasm after editing wasm/dsp (needs Rust with the wasm32 target)
```

The built `dsp.wasm` is committed so the app builds without Rust.

## Licenses

All dependencies are permissively licensed (checked by `npm run check:licenses` before every build). The bundled models are MediaPipe models, Apache 2.0: the selfie segmenter for people (`src/media/models/person-segmenter.tflite`), the face landmarker for faces (`src/media/models/face-landmarker.task`, float16) and the hair segmenter for hair color (`src/media/models/hair-segmenter.tflite`, float32). Fonts are SIL Open Font License or Apache 2.0. Icons are from Lucide (ISC) plus original glyphs. All effects, transitions, filters, graphics and sound effects are original.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
