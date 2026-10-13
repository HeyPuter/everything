# Photo Studio architecture

Photo Studio is a browser image editor (vanilla TypeScript, Vite, Puter.js).
This guide is for contributors adding features.

## Layout of the source

| Area | Location | Notes |
| --- | --- | --- |
| Workspace chrome | `src/app/` | Registries, menus, toolbar, dock, pointer input, shortcuts, icons |
| Orchestrator | `src/editor.ts` | Sessions (open documents), history access, update loop, view |
| Features | `src/features/` | Each feature registers commands, tools, panels and overlays |
| Document model | `src/model/` | Immutable-snapshot documents, tiles, selections, PSD codec |
| Imaging | `src/imaging/` | Pure algorithms on typed arrays (filters, adjustments, codecs, effects, text...) |
| Painting engine | `src/engine/paint.ts` | Dab-based strokes into copy-on-write tiles |
| GPU compositor | `src/renderer/` | WebGPU with WebGL2 fallback; both shaders must stay in sync |

## Registries (`src/app/registry.ts`)

- `registerCommand({ id, label, run, shortcut?, enabled?, checked?, menu?, hidden? })`.
  Menu placement comes from `src/app/menus.ts` (`menuSkeleton`): a command whose ID
  appears there shows up automatically; unregistered IDs are omitted. Dynamic submenus
  (e.g. `filter.blur`, `window.panels`) collect commands whose `menu` field names them.
  Shortcuts use `Mod` for Command/Ctrl, e.g. `Mod+Shift+N`, `Alt+Backspace`, `F5`.
- `registerTool({ id, label, key, icon, group, options, bindOptions, pointerDown/Move/Up, hover, keyDown, overlay, activate, deactivate, cursor })`.
  `group` selects the toolbar slot (see `toolGroups` in `src/app/toolbar.ts`); tools in
  one group share a slot with a flyout, and Shift+key cycles them.
  Pointer events give `CanvasPointer` (`x`, `y` in document pixels, `pressure`, modifier flags, `coalesced` samples).
- `registerPanel({ id, title, icon, location: 'dock-top'|'dock-middle'|'dock-bottom'|'strip', mount, update, menu })`.
  `mount` runs once; `update` runs after every edit while the panel is visible.
  Window → Panels entries are generated. `menu` lists the panel's own commands;
  the dock appends the standard items (minimize, collapse to icon or dock as tab,
  close) to every panel menu. Strip sections are listed in `stripSections` (`src/app/dock.ts`).
- Icons (`src/app/icons.ts`) are Lucide glyphs plus original ones on the same
  24-unit grid (1.7 stroke, round caps and joins). Give each tool its own glyph;
  `tests/icons.test.ts` fails on literal names that do not exist.
- `registerOverlay(id, (e) => svgMarkup)` draws document-space SVG above the canvas (use `1 / e.zoom` for hairlines).
- `contributeMenu(menuId, items, afterId?)` inserts items into an existing menu.
- Feature entry points are listed in `src/features/index.ts` (one line each).

Never show a control that does nothing: register a command only when it works.

## Loading on demand (`src/app/lazy.ts`)

Registration stays eager (menus, toolbar, shortcuts and panels are complete at
startup); implementations load with `import()` on first use. Keep a feature's
`index.ts` and the modules it imports statically light: no dialogs, codecs,
workspaces or heavy algorithms.

- `lazy(() => import('./dialog'))` is a memoized loader; `.loaded` gives
  synchronous access once loaded, `.prefetch()` starts it quietly. Loads slower
  than ~150 ms show a progress cursor and a bar on the status bar.
- `registerCommand({ id, label, ...lazyRun(mod, (m, e, arg) => m.open(e, arg)) })`
  runs a function of the module; menus prefetch it on hover.
- `lazyTool(meta, loader)` registers a tool from its toolbar metadata; it loads
  when chosen or hovered, and pointer input that arrives earlier is replayed.
  `lazyPanel(meta, loader)` mounts a panel body when first shown.
- `prefetchOnIdle(...)` and `whenIdle(task)` run work when the browser is idle
  (likely-next modules, installed-font detection).
- State that menus and hooks read at any time (`enabled`/`checked`, layer
  badges, update hooks) lives in small modules next to the implementation
  (`filters/state.ts`, `embedded/link-state.ts`, `transform/session-state.ts`);
  the implementation re-exports it so existing imports keep working.
- The Filter menu comes from `filters/menu.ts` (generated from the catalog,
  checked by `tests/filters-menu.test.ts`; regenerate with `UPDATE_FILTER_MENU=1`).
- Workers are separate chunks (`new Worker(new URL(...))`).

Panels that redraw on every update should patch rather than rebuild: the
Layers panel describes one HTML fragment per row and `patchList`
(`src/ui/patch-list.ts`) keeps unchanged rows. See `docs/performance.md` for
measurements and the opt-in timing budgets.

Shortcuts are global: give each command its own (`tests/shortcuts.test.ts` runs
`shortcutConflicts` over the real registry for macOS and Windows/Linux, where Ctrl
is the Mod key). A shortcut list can hold platform alternatives; menus show the
first one that can be typed. Brush-like tools get [ ], Shift+[ ] and Alt+right-drag
by defining `brush`, and number keys through `e.settings.numberKey(value, shift)`.
Use an ellipsis (…) in a label exactly when the command asks for input before
acting. `tests/menus.test.ts` checks the menu tree (orphans, anchors, labels,
reachability) and `tests/browser/smoke-all.spec.ts` runs every command, tool and
panel in the browser; add fixture state there when a new command needs it.
Options-bar controls get tooltips from `src/app/option-tips.ts` when they have no
`title`; add an entry for a new control whose label alone does not explain it.

## Documents, history and tiles

- `e.doc` is the current immutable `PhotoDocument`. Change it only through
  `e.command(label, (draft) => { ... })` (one undo step) or `e.editLayer(label, fn)`.
  Live previews: build a modified document (shallow copies) and call `e.preview(doc)`.
- Layer kinds: `pixel` (destructive tiles), `image` (embedded object with
  non-destructive transform), `text`, `vector`, `solid`, `group`, `adjustment`, legacy `paint`.
- Pixel content lives in `TileGrid`s (`src/model/tiles.ts`): 256 px immutable tiles
  shared between history states. Read with `readRGBA/readMask(store, grid, rect)`,
  write with `writeRect(store, grid, x, y, buffer)` which returns a *new* grid.
  `e.assets.tiles` is the store. Never mutate a tile that a committed grid references.
- Pixel layers keep `transform` equal to their content bounds (`syncPixelTransform`).
  Moving/transforming them is baked automatically when the edit is committed.
- Selections: `doc.selectionMask` (1-channel grid, origin 0) and `doc.selection` (its
  bounds). Use `selectionGrid`, `applySelection`, `commitSelectionMask(e, mask, op, label)`.
- Layer masks painted in the app are `layer.maskGrid` (fill 255 = reveal all).
- Identifiers of layers, channels, embedded objects, audio tracks and clips, comps,
  slices, paths, frames and annotations are made with `crypto.randomUUID()` and must
  match `ID_PATTERN` (`src/model/ids.ts`); `validateDocument` refuses others. Still
  escape them with `escapeXML` wherever they go into markup.

## Document windows and views (`src/app/views.ts`)

- A `DocumentView` is one window onto a session (document) with its own zoom, pan,
  rotation and mirroring; `e.views` lists them and `e.activeView` receives input.
  `e.session` is the active view's document; assigning it switches to that
  document's most recent window.
- Geometry lives in `src/app/view-transform.ts`. Convert coordinates only with
  `e.docPoint` / `e.clientPoint` (or `e.viewMatrix()`); the stage can be rotated,
  so never derive document coordinates from `#stage` bounding boxes.
- `WindowManager` (`e.windows`) lays out tabbed, tiled, n-up and floating windows
  (`src/app/view-layout.ts`). Only the active window hosts the live canvas; others
  draw a copy of their document's last frame, taken through
  `renderer.frameListeners` (also used by Pattern Preview).

## Helpers for pixel features (`src/features/pixels.ts`)

- `pixelTarget(e)` resolves what painting/filters should edit: the selected pixel
  layer, its mask when the mask thumbnail is active, Quick Mask, or rasterizes an
  embedded/text/shape layer first. `commitTarget(e, target, grid, label)` stores the result.
- `applyToLayer(e, label, (src, rect) => out)` runs an RGBA8 operation on the target
  layer, restricted and blended by the active selection, as one undo step.
- `compositeRGBA(e)` and `layerRGBA(e, layer)` read pixels back from the GPU.

## Embedded objects (`src/model/embedded.ts`, `src/features/embedded/`)

- `doc.embeds[id]` holds the content of an embedded object: a nested `.photo`
  project asset (`project`), the original file (`source`), the rendered result
  drawn by instances (`composite`), an optional `link` and `stack` mode. An
  `image` layer with `embed.contents` is an instance; Duplicate Layer shares the
  entry, New Embedded Object via Copy copies it. Changing content always makes
  new assets and a new entry (`setContents`), so undo is a reference swap.
- Edit Contents opens the project in a new session; that session's `saveHandler`
  renders it and executes one history step in the parent session.
- Skew, distort, perspective and warp store `embed.frame` (quad, optional mesh,
  the rectangle of the cached render and the composite it came from). `asset`
  is then a cache rendered from the composite; `scheduleRefresh` re-renders
  stale caches in place after edits (it is derived data, not a history step).
  Later rectangle edits of `transform` compose with the frame (`effectiveFrame`).
- Composites and per-layer stack inputs render on a private offscreen
  compositor (`embedded/render.ts`), never on the visible canvas.

## Layer styles, fill layers and patterns (`src/features/effects/`)

- `layer.style` holds a `LayerStyle` (`src/imaging/effects/types.ts`). The compositor
  (`src/renderer/layer-style.ts`) reads the layer's document-space pixels (tiles for
  plain pixel layers, otherwise a render-alone readback), renders effects in a worker
  through the function registered with `registerStyleRenderer`, and composites the
  below/layer/above passes in place of the layer. Results are cached by content and
  style; a move only translates them. The interactive canvas draws ready results
  while new ones render (`renderer.progressiveStyles`); readbacks and exports wait.
- Fill layers are kind `solid` with `fill` (`src/model/fill-layer.ts`): a gradient or a
  pattern rendered by the compositor and edited in Properties.
- `doc.patterns` stores patterns defined from pixels (tile grids, saved with the project).
- PSD export rasterizes styled layers and fill layers into pixels with effects baked in.
- `doc.globalLight` replaces each style's own global angle/altitude when set (Global Light dialog).

## Advanced blending and spatial adjustments

- `layer.blending` (`src/model/blending.ts`) holds Blend If ranges, excluded channels,
  knockout and the group/mask options. The composite pass uniforms are 96 floats
  (`UNIFORM_FLOATS`): floats 48–79 carry the ranges and 80–83 the Blend If flag and
  excluded channels (`blendingUniforms`). Mode `u[29] = 4` mixes the backdrop toward
  the source by a document-sized shape mask (knockout, clipped layers that do not
  blend as a group). `rangeWeight`/`blendIfWeight` are the CPU reference of the shader math.
- Knockout backdrops: `Renderer.knockStack` holds a copy of each enclosing group's
  start (shallow); the Background layer alone is rendered once per draw (deep).
- Spatial adjustment kinds (Clarity & Dehaze, Grain) render through
  `Backend.filterPass` (`filter-shaders.ts`, `spatial-pass.ts`); the CPU reference
  in `src/imaging/adjust/spatial.ts` serves destructive commands and tests.

## Artboards, frames, comps and slices (`src/features/layout/`)

- Guides (`src/model/guides.ts`, `src/features/guides.ts`): canvas guides are
  `doc.guides` in document coordinates; artboard guides are
  `layer.artboard.guides`, offsets from the artboard's corner, so they move,
  duplicate and disappear with it. `placedGuides` lists both in document
  coordinates with selection keys (`c:<i>`, `a:<artboard>:<i>`); snapping uses
  `guideLines`. A guide dropped on an artboard joins it. `migrateGuides` checks
  guide lists when a project is read; older projects keep their guides as
  canvas guides.

- Artboards and frames are groups with `layer.artboard` / `layer.frame` data
  (`src/model/artboard.ts`, `src/model/frame.ts`). Artboards stay at the top level.
  The compositor (`Renderer.groupSource`) draws an artboard's background and clips
  artboards and frames through the shared pass, so both backends behave the same.
- Layout geometry (artboard and frame rectangles, slices, comp positions) follows
  crops, resizes and canvas rotations through `mapLayoutGeometry`.
- Hooks for moving layers: `layerMoveHooks` and `pickFallbacks` (`src/ui/transform.ts`)
  and `snapProviders` (`src/model/transform.ts`).
- `doc.layerComps` and `doc.slices` hold comps and user/layer-based slices; automatic
  slices come from `partitionSlices`. `src/imaging/codecs/pdf.ts` writes image PDFs.

## Video timeline and video layers (`src/features/animation/video*.ts`)

- A document has either `doc.animation` (frame animation) or `doc.timeline`
  (`src/model/video-timeline.ts`): frame rate, duration and current time in
  timeline frames, a work area, and a `Clip` per layer (absent records span the
  whole timeline) with `start`, `in` (content trimmed from the start), `length`,
  keyframes for position (offsets), opacity and layer style (linear or hold)
  and fade/fade-with-color/cross-fade transitions. Keyframe times count from
  the content's start, so they move with the clip.
- As with frame animation, the layers show the current time: `applyTime`
  (`video-timeline-ops.ts`) writes keyed values and video frames into them, and
  `syncTimeline` (a document hook) records edits at the current time as keys
  (when the property's stopwatch is on) and as altered frames of video layers.
  `applyTime` marks its own changes (`placed`) so they are not recorded.
- Clip ranges and transitions apply only when a document is drawn:
  `presentTimeline` runs through `registerPresentation` in the renderer
  (layers read back alone are not affected), so the Layers panel keeps each
  layer's own visibility and opacity.
- A video layer is a pixel layer with `layer.video` (`src/model/video-layer.ts`):
  the footage (an opaque source asset), the frame origin, interpreted frame
  rate, alpha and loops, a run-length map of footage and blank frames, and
  altered frames as tile grids. `pixels` holds the frame shown, so painting,
  filters and adjustments work unchanged and become the frame's alteration.
- Footage decodes on demand (`video-frames.ts`): WebM through the demuxer
  (`imaging/codecs/webm-demux.ts`) and WebCodecs, continuing forward while
  playing; other formats by seeking a hidden `<video>`. Decoded frames are tile
  grids in an LRU `FrameCache` (budget in Preferences → Performance) whose tiles
  are kept through `tileHolders`. `setTime` decodes before it commits a
  coalesced "Set Current Time" step; `editTimeline` does the same for edits.
- Playback (`video-playback.ts`) previews `timeDocument` copies in real time,
  skipping frames still decoding. Render Video builds the same copies per
  output frame and encodes them as they render.
- Video layer placement: frames live in layer space at `video.x/y`; footage
  frames reach it through `video.matrix` and each altered frame through its
  `alteredMatrix` entry (absent = identity). `transformVideo` composes a
  document transform into all of them. Canvas edits do this in
  `mapDocumentGeometry` (the point map is fitted as a projective matrix);
  layer transforms do it where they rebuild a pixel layer (`applyPrepared` for
  layer flips and rotations, the transform session, Transform Again and
  `commitPixelResample`). Placing a time resamples a frame through its matrix
  (`lookup.place`, cached by tiles and matrix); whole-pixel moves place grids
  as they are. Painting a resampled frame stores it in layer space without a
  matrix. Mode and profile conversions (`mapDocument`) convert every frame,
  keeping converted footage frames as altered frames. Mesh warps are refused.
- Layer comps act on the layers as shown at the current time: with a stopwatch
  on, the position, opacity or style they change becomes a keyframe.
- Artboards and a video timeline do not mix: the history hook refuses an edit
  that would combine them, and the artboard commands say so up front.
- Audio (`src/model/audio-timeline.ts`): `timeline.audio` lists audio tracks
  (absent: one empty default track, created by `ownTracks` on the first edit)
  with clips in seconds (`start`, `in`, `length`), a gain in dB and fade
  lengths; tracks have a volume, mute and solo. A clip plays an audio file
  (`source`, an opaque source asset) or, with `link`, the sound of a video
  layer (`video.audio`, the footage asset) and then takes its times from that
  layer's clip (`clipSpan`), so edits of a linked clip edit the video clip.
  `syncAudio` (part of `syncTimeline`) drops linked clips of deleted layers
  and links the sound of video layers that are new in an edit (imports,
  splits, duplicates). `audioPlan` is what plays after mute and solo.
- Sound decodes with Web Audio at 48 kHz (`audio-media.ts`, cached by asset,
  waveform peaks at several block sizes from `imaging/audio/peaks.ts`).
  `imaging/audio/mix.ts` mixes a plan offline, sample accurately, for Render
  Video (Opus through WebCodecs into the WebM writer's second track, or WAV)
  and tests; playback (`audio-playback.ts`) schedules the same plan on an
  `AudioContext` with gain ramps, and its clock drives the frame shown.
  Audio clip commands act on `videoView(e).audioClips` while any is selected.

## Assisted editing (`src/features/assist/`)

- Puter AI calls live only in `src/imaging/ai/puter-ai.ts` and run only from an
  explicit button press in a dialog (or the Assistant's Send) that states what is
  sent (prompt, pixels, document description) and that it needs a Puter account. Results become new layers; the prompt is
  kept in `layer.generated` and shown in Properties. Tests replace `aiCodec`
  and stub `globalThis.puter`.
- Classical counterparts run in the assist worker (`worker.ts`): Enhanced
  Upscale (`imaging/filters/upscale.ts`), object detection
  (`imaging/segment/objects.ts`). Denoise and Sharpen Details are ordinary
  filter operations (`imaging/filters/restore.ts`).
- `commitResampled` (`features/transform/image-size.ts`) stores resampled
  layer, mask, live-filter, channel and selection grids as one history step.

## Assistant and Generation History (`src/features/assistant/`, `src/features/generations/`)

- The Assistant turns a request into a plan of registry commands and its own
  operations (`ops.ts`: select, crop to an aspect ratio, adjustment layers
  with settings, layer styles, text, layer properties). The model gets a
  fixed system prompt (operations and common commands) and four tools
  (`model.ts`): `search_catalog` (ranked one-line matches from `catalog.ts`,
  built from the live command, tool and panel registries with menu paths),
  `get_details` (settings schemas on demand: filter `ParamSpec`s, adjustment
  defaults, AI dialog prefills), `propose_plan` and `answer`. Chat goes through
  `chatWithTools` in `imaging/ai/puter-ai.ts`; tests pass a scripted chat
  function (`setChat`, or a stubbed `puter.ai.chat` in the browser).
- `plan.ts` resolves and checks every step against a `PlanEnv` (registry,
  preloaded settings schemas, whether a command needs a selection, document
  state): arguments are coerced with `params.ts`, and selection effects are
  carried from step to step. Problems are plain sentences on the step; a plan
  with any does not run.
- `runner.ts` runs steps through a `ScriptHost` (commands with their recorded
  `{ params }`, AI commands with `{ prefill }` so only their dialog opens), and
  `host.finish` squashes the run into one undo step named after the request.
  A step-by-step run closes its undo step at each pause (`PlanRun.pause`), so
  edits made while it waits stay their own steps; going on from an unchanged
  document continues the same step (`History.resume`).
  Commands that apply settings directly without a dialog can declare them in
  `catalog.ts` (`SETTINGS_PARAMS`).
- Generation History stores results in its own IndexedDB database
  (`persistence/generations.ts`, bounded by count and bytes). Dialogs that
  generate call `recordGeneration` (`features/generations/record.ts`) with
  every image that arrived; Reuse Settings reopens the dialog with `{ prefill }`.
- `MenuBar.reveal(id)` opens the menus leading to a command and highlights it
  (the Assistant's Show me). A feature can register its own `window.panel.<id>`
  command (listed directly in the Window menu); the dock keeps it.

## Portrait & Restore (`src/imaging/restore/`, `src/features/restore/`)

- One pseudo-operation (`RESTORE_ID`, like the Filter Gallery) whose settings
  list the eight filters (`defs.ts`: groups, `ParamSpec`s, `normalizeRestore`).
  `pipeline.ts` runs the enabled ones in `RUN_ORDER` and limits the result by
  the selection; the filter worker runs it for Live Filters and actions
  (`runOperation` loads it on first use).
- Pixels that settings cannot carry (AI results, a depth layer) are named
  extras (`entry.aux`) that only the workspace's own worker has; `replayable()`
  turns them off for Live Filters and recorded steps, and `isDeterministic()`
  decides whether Live Filter output is offered.
- The workspace worker (`features/restore/worker.ts`) keeps a source pyramid and
  a cache of stage results keyed by everything a stage depends on, so moving a
  slider of a later filter reuses earlier stages. A newer run supersedes an
  older one between stages. Previews render a coarse level, then a level
  matching the zoom; zooming past it renders full size on a second worker,
  which Stop terminates.
- AI filters are sent the stack's result at their own input (the filters
  before them in `RUN_ORDER`), rendered on a third worker and kept per
  setting of those filters, so generating again sends the same pixels. AI
  stages keep the layer's alpha. While OK applies, the settings are snapshot
  and the controls inert; previews pause and arriving AI results wait.
- Live output adds the filter to the layer's own stack (`LiveTarget` in
  `filters/apply.ts`), also while its mask or Quick Mask is edited. Its
  preview follows the layer's Live Filter mask; with a selection it is offered
  only when the selection would become a mask for this filter alone.
- Global estimates (skin regions, depth, colorization) run at a working size
  relative to the image so previews match the full-size result; JPEG cleanup
  as the first filter cleans the full-resolution source even for previews,
  because block edges exist only on the original pixel grid.

## Type on paths and variables

- Block text (`textData.block`) is laid out as point text and then each line is
  scaled about its left end to one width and stacked by capital height
  (`imaging/text/block-text.ts`), so shaping and carets are unchanged.
- In vertical text `CharStyle.vertical` sets Latin and digits upright, rotated
  sideways (runs with `angle`, advancing by their width) or, for 'combine', runs
  of up to three characters set horizontally in one cell (`verticalForms` in
  `layout.ts`); ideographs always stay upright.

- Path and area text keep their path in `textData.path` (`TypePath`, local text space).
  `layoutText` lays path text out straight and bends it onto the path
  (`src/imaging/text/path-text.ts`): runs become rotated glyphs, and `layout.map` /
  `layout.unmap` convert between straight and local coordinates, so carets, selections
  and hit testing reuse the straight geometry. Area text breaks lines into the spans of
  the shape. The path is also a `PathTarget` of kind `text`, so the pen and path
  selection tools edit it; `selectHooks` let the type feature claim its markers.
- Match Font measures text with pure functions (`src/imaging/text/match-font.ts`:
  binarizing, deskewing, glyph segmentation, gradient-histogram descriptors, ranking)
  and draws candidates through an injected renderer: canvas text in the dialog
  (`features/type/match-font.ts`), glyph outlines from the font files in tests.
- `doc.variables` binds layers to variables and holds data sets (`src/model/variables.ts`).
  `documentWithSet` (`src/features/variables/apply.ts`) builds the document a set
  produces without committing it, for previews, Apply Data Set and batch export.

## Scripting and application events (`src/features/scripting/`)

- Application events (`src/app/app-events.ts`): `emitAppEvent('new-document' | 'open-document' |
  'before-save' | 'after-save' | 'export' | 'close-document' | 'start', session)`.
  Code that creates, opens, saves, exports or closes documents announces it; `before-save`
  is awaited. `withoutAppEvents(work)` keeps batch processing quiet.
- Scripts run in `ScriptSandbox` (`sandbox.ts`): a hidden `sandbox="allow-scripts"` iframe
  with a strict CSP starts a worker with `runtime.js` (the `studio` API as scripts see it)
  followed by the script. Everything crosses one MessageChannel as structured clones.
- `ScriptHost` (`host.ts`) implements the API on the editor: it checks every argument,
  activates the document an edit targets, and combines a run's history states into one
  step per document with `History.mark` / `History.squash`. Tests drive it with a mock editor.
- Installed scripts and event rules live in IndexedDB (`store.ts`, database
  `photo-studio-scripts`); enabled scripts register `script.run.<id>` commands with
  `menu: 'file.scripts'`. A new API method is one entry in `ScriptHost.table`, one wrapper in
  `runtime.js` and a line in `docs/scripting.md`.

## Libraries, provenance and image assets

- Libraries (`src/features/libraries/`): `model.ts` is the index format and
  the edit operations (`LibraryOp`), which are idempotent and refer to IDs, so
  replaying queued edits on a newer index merges concurrent changes.
  `storage.ts` keeps the working copy in IndexedDB (`photo-studio-libraries`:
  index, queued edits, content-addressed asset blobs) and, while signed in,
  syncs with the app's Puter folder (`libraries/index.json`,
  `libraries/assets/<sha256>`): read, replay, write with a new revision and
  writer nonce, read back to confirm, retry otherwise; recently written edits
  are replayed for a while so a writer that missed them cannot drop them.
  Tabs hear about changes through a BroadcastChannel. Placements made with
  Place Linked are embedded objects whose `link.kind` is `library`
  (`linkReaders` in `embedded/link-state.ts` reads them).
- Provenance (`src/features/provenance/`, codecs in `src/imaging/provenance/`):
  the recorder watches new history states of the active document (labels,
  `e.currentCommand` / `e.lastCommand`), placed embedded contents and
  `openedFiles` (`app/app-events.ts`), and keeps one `ProvenanceRecord`
  (`model/provenance.ts`) per session. Projects store it as a sidecar
  (`projectSidecars` in `model/serialization.ts`: data beside the document,
  outside the undo history). `attachProvenance` writes the XMP packet, then
  the C2PA-format store with a hard binding found by fixed-point layout;
  `inspectProvenance` never throws.
- Image Assets (`src/features/image-assets/`): `names.ts` parses layer names,
  `plan.ts` turns a document into outputs, `generate.ts` renders, encodes
  (export worker) and writes them; see `docs/image-assets.md`.

## Preferences, versions and recovery

- `src/model/preferences.ts` is the schema of Edit → Preferences (pages, sections,
  types, defaults), with validation, migration from older stored layouts and
  JSON import/export. A new setting is one `SETTINGS` entry plus the code that
  reads `e.preferences.<key>`; workspace-wide effects (CSS variables and
  classes) live in `features/preferences/apply.ts`. Call
  `e.preferencesChanged()` after changing a value; features that cache a
  setting subscribe with `e.preferenceHooks`.
- `src/persistence/local-store.ts` wraps IndexedDB (`MemoryStore` for tests);
  `persistence/versions.ts` stores versions and recovery records on it.
  `e.saveHooks` run after a project is written (versions, recovery cleanup).
- Warnings that can be turned off use `warnOnce` (`features/preferences/warnings.ts`).

## Canvas edits and document-wide state

- A canvas edit (resize, crop, rotation, flip, perspective crop) maps the state kept
  beside the layers through one point map with `mapDocumentGeometry` (paths,
  annotations, layout rectangles and comp positions, variable placements, perspective
  planes, guides and frame offsets). Edits that rebuild layer content also call
  `remapCompPositions`, which keeps comp positions relative to their layers.
  Add new document-space state there, not to each command.
- Change `doc.resolution` with `setDocumentResolution`: type sizes are in points and
  are converted so text keeps its size in pixels.
- Restore a whole state (revert, snapshot, version) with `replaceDocument`, which also
  removes properties the state does not have.
- Turn a layer of another kind into pixels with `clearToPixelLayer` and store pixels of
  a Live Filter layer moved by a canvas edit with `setLivePixels`.
- Masks that belong to a layer's content (linked layer mask, Live Filter mask) are
  carried through its transforms with `carryMask`; for layers other than pixel layers
  the history does this (`followLinkedMasks`) from the change of the content placement.
- `renderer.beforeReadback` runs before composite and layer readbacks; it waits for
  pending embedded object frame renders, so pixels read right after an edit match it.

## Imaging conventions

Pure functions on `RGBA8`/`Mask8` (`src/imaging/types.ts`), straight alpha,
deterministic, no DOM. Operations with parameters implement `ImageOperation` so the
UI can generate dialogs, presets, recorded actions and live filters from `params`.

## Tutorials and user activity (`src/features/help/`)

- `src/app/activity.ts` announces what the user did: `emitActivity({ kind: 'command', id })`
  after `runCommand` finishes a command and `{ kind: 'tool', id }` from `setTool`.
  `onActivity(listener)` returns an unsubscribe function; with no listeners it costs nothing.
- A tutorial (`tutorials.ts`) is a list of steps with a card text, an anchor (selector,
  tool, panel, top-level menu, command button or the canvas) and how it completes:
  `commands` (one of them ran), `tool` (it is active) or `check(now, base)`, which
  compares the workspace with its state when the step began (`checks` in `tour.ts`:
  layer added, pixels or mask changed, selection made, opacity lowered and so on).
  History states are deep copies, so checks compare content (tile IDs), never
  object identity. A step counts only work in the document it began in.
  Steps without any of these are read and continued with Next.
- `TourMachine` (`tour.ts`, pure) holds the step index, completed steps, back, skip and
  restart; `tour-ui.ts` draws the card and the ring around the anchor and evaluates the
  current step on activity, on editor updates and on a short timer (zoom changes and
  layout moves do not announce themselves, and background tabs get no animation frames).
- Each tutorial opens a procedurally generated sample (`samples.ts`, seeded, no downloads).
  What's New entries (`whats-new-data.ts`) name a command, tool, panel or tutorial; the
  window hides "Try it" when the target is not registered.

## Legal

Use original, descriptive feature names and original icons and presets, and
record every third-party component in `docs/third-party.md`.
