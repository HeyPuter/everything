# Roadmap: professional editing parity

This checklist tracks the features a professional raster editor is expected to
offer that Photo Studio does not have yet. Items are grouped by work stream; each
stream lands as its own set of commits. Names are plain and descriptive.

Status: `[ ]` planned, `[x]` done.

## Embedded objects

- [x] Convert layers to an embedded object; new embedded object via copy
- [x] Edit contents in a separate document tab; saving updates every instance
- [x] Replace contents, export contents, convert back to layers, reset transform
- [x] Linked objects (placed from a file, update modified content, embed linked)
- [x] Open a file as an embedded object
- [x] Stack modes (mean, median, maximum, minimum, range, …) and Load Files into Stack
- [x] Live filter submenu: disable/enable all, delete/disable filter mask, clear

## Artboards, frames, layer comps, slices

- [x] Artboard tool, artboard layers (from group/layers), per-artboard background and clipping
- [x] Export artboards to files and to PDF; fit artboard on screen
- [x] Frame tool and frame layers (placeholder that masks placed images)
- [x] Layer comps panel (visibility, position, appearance), export comps to files/PDF
- [x] Slice and slice select tools, layer-based slices, export for web with slices
- [x] Copy CSS and copy SVG for a layer

## Animation

- [x] Timeline panel with frame animation (per-frame layer visibility, position, opacity, style)
- [x] Tweening, frame delays, loop count, onion skinning
- [x] Export animated GIF, WebP, PNG; render video (WebM)
- [x] Import video frames to layers; de-interlace and broadcast-safe color filters

## Video layers and video timeline

- [x] Video layers from files (decoded on demand into a bounded frame cache) and blank video layers painted frame by frame; altered frames saved in projects
- [x] Insert, duplicate and delete frames; replace and interpret footage (frame rate, alpha, loops); show altered video; restore, reload and rasterize frames
- [x] Video timeline in the Timeline panel: ruler, current-time indicator, zoom, work area, clip bars that move, trim and split at the playhead
- [x] Position, opacity and style keyframes with stopwatches and linear or hold interpolation
- [x] Playback at the timeline frame rate, onion skins, fade, fade with color and cross fade transitions, duration and frame rate settings
- [x] Conversion between frame animations and video timelines; Render Video of the timeline to WebM or a PNG image sequence (ZIP)
- [x] Audio tracks: footage sound, audio clips, mixing, playback and rendered sound

## Measurement and annotation

- [x] Ruler tool (angle/length readout, straighten layer)
- [x] Color sampler tool (several fixed samplers shown in Info)
- [x] Count tool with groups
- [x] Note tool and Notes panel
- [x] Measurement scale, scale marker, record measurements and Measurement Log panel

## Warps and transforms

- [x] Pin warp (mesh deformation driven by pins)
- [x] Perspective warp (layout planes, then warp)
- [x] Context-aware scale (protect content while rescaling)
- [x] Split warp grids

## Multi-image and compositing

- [x] Auto-align layers and auto-blend layers (panorama and focus stacking)
- [x] Panorama merge, merge exposures to HDR, HDR toning
- [x] Apply Image and Calculations
- [x] Sky replacement
- [x] Crop and straighten scanned photos
- [x] Contact sheet, fit image, PDF presentation, conditional mode change
- [x] Trap (CMYK)

## Workspace and view

- [x] Rotate view tool, flip view, 200% / print size / fit layers views
- [x] Arrange documents: tile, n-up, float, match zoom/location/rotation
- [x] Workspaces (presets, new/delete, lock), toggle tools and options bar
- [x] Snap to individual targets, alignment guides, layer edges, show all/none extras
- [x] Find layers, isolate layers, link layers, select linked layers
- [x] Paste into / paste outside, purge clipboard/all
- [x] Tool presets panel; menu and toolbar customization
- [x] Proof individual plates and color-vision deficiency simulations

## Painting and type

- [x] Mixer brush and art history brush
- [x] Clone Source panel (multiple sources, offset, scale, rotation, overlay)
- [x] Shapes panel, Glyphs panel, character and paragraph styles
- [x] OpenType features, find and replace text, spell check, right-to-left text
- [x] Filters: shape, field, path and spin blurs; flame, picture frame and tree; HSB/HSL; focus area; wide-angle correction; perspective planes

## Layer blending, styles and adjustments

- [x] Blend If (gray and color channels, this layer and underlying, split handles) in both compositor backends, PSD and .photo
- [x] Advanced blending: channel exclusion, shallow/deep knockout, interior effects and clipped layers as group, masks that hide effects
- [x] Layer Style submenu entries per effect, document-wide Global Light, Create Layers from effects, Layer Content Options
- [x] Light & Tone, Color & Vibrance, Clarity & Dehaze and Grain adjustments (layers on the GPU and destructive commands)
- [x] Multichannel mode, 32-bit preview options, color lookup table export, import layers

## Assisted editing

- [x] Generate Image (prompt, style and aspect presets, variations, regenerate) and Edit with Prompt (image to image) through Puter AI, results as new layers with the prompt
- [x] Upscale: offline edge-directed Enhanced Upscale (1.5–8×, worker) with an optional generative AI layer
- [x] Denoise (non-local means, automatic noise level) and Sharpen Details (Richardson–Lucy deconvolution) as filters, live filters and actions
- [x] Mask All Objects (masked copies, masked groups or saved selections per object)
- [x] Harmonize (Lab color transfer to the layers beneath, clipped Color Lookup layer or pixels)
- [ ] Reflection removal: not shipped; no classical single-image method gave dependable results

## Type on paths and data-driven graphics

- [x] Type on a path (work paths, saved paths, shape outlines) with start/end markers and flipping
- [x] Area type inside closed paths, with an inset
- [x] Convert to Arc Text (arch, circle, bow, wave), path type options, text shape type conversions
- [x] Path text in PSD (pixels on export, editable import where readable), outlines for shapes and work paths
- [x] Variables (visibility, text replacement, pixel replacement) and data sets: define, edit, import CSV/TSV, apply
- [x] Export data sets as files (PNG, JPEG, PSD, .photo) with progress

## Preferences, new documents, versions and recovery

- [x] Preferences window: page sidebar, search, live changes, import/export JSON, schema validation and migration
- [x] General, Interface, Workspace, Tools, History & Autosave, File Handling, Export, Performance, Cursors, Transparency & Gamut, Units & Rulers, Guides/Grid/Slices and Type pages, every setting wired
- [x] New Document window with preset categories, saved and recent presets, units (including columns), artboards, mode, background, profile and pixel aspect ratio
- [x] Recent documents with thumbnails on the start screen; local files reopen after a reload
- [x] Version History panel: versions on save, at the autosave interval and on demand; preview, restore, open as copy, delete (local only: Puter.js has no file version API)
- [x] Crash and tab-close recovery of unsaved documents
- [x] File → Package as ZIP (project and linked files) and Export → Paths to Vector File (SVG)

## Visual fidelity and UX polish

- [x] One original icon family: distinct glyphs for every tool, panel and workspace tool; no shared or ambiguous icons; unknown names caught by a test
- [x] Every panel has a flyout menu (own commands, then minimize, collapse to icon or dock as tab, close, close tab group); the icon strip is grouped into labelled sections
- [x] Preview dialogs share one footer (options left, Cancel then the primary button right); large windows resize; no overflow at 1280×720
- [x] Start screen with one-click presets; status bar zoom field and a document information item (sizes, dimensions, profile, memory, scale, tool)
- [x] Text contrast of at least 4.5:1 in dark, medium and light themes; accessible names on all controls; themed scrollbars and pressed states

## Command, tool and panel QA, shortcuts and tooltips

- [x] Smoke test of every command, tool and panel, in an empty workspace and with a document of every layer kind (errors, stuck busy state, undo, missing tiles, renders)
- [x] Menus audited against professional editors: no orphan IDs, grouping and order, ellipses only where input is asked, no repeated labels, unit-tested
- [x] Shortcuts matched to professional editor conventions, with a conflict test per platform; layer stepping (Alt+[ ]), blend mode cycling, two-digit opacity, Shift+number flow, [ ] for every brush tool
- [x] Help → Keyboard Shortcuts lists every shortcut by menu, the tool keys and the painting and navigation keys
- [x] Tooltips with keys for every tool and options-bar control

## Cross-feature consistency (documents and data model)

- [x] Canvas edits (Image Size, Upscale, Crop, Trim, Reveal All, Canvas Size, rotate, flip, Bitmap) carry guides, paths, vector and group masks, annotations, comps, variables, frame offsets and Live Filters
- [x] Projects stay valid after rasterizing type and after resampling Live Filter layers; mode conversions cover type runs, Live Filter sources, patterns and artboard colors
- [x] Readbacks wait for embedded object frame renders; framed instances keep their scale when contents resize
- [x] Revert, snapshots and versions restore exactly, also with a frame animation; Toggle Last State flips between two states
- [x] Resolution changes, Import Layers and Convert to Layers keep type at its pixel size; Import Layers keeps embedded contents that share an ID
- [x] Image Size scales layer effects; Reveal All includes rotated layers
- [x] Linked layer, vector and Live Filter masks follow scaling, rotation and distortion of their layers; imported PSD masks turn with the canvas
- [x] Define Variables frees the names of deleted layers

## Performance

- [x] Startup bundle split: commands, tools and panels register eagerly; dialogs, workspaces, codecs, filters and tool implementations load on first use with idle prefetching
- [x] Installed-font detection and other startup work moved to idle time
- [x] Keyed Layers panel updates; rulers and overlays skip identical redraws
- [x] Opt-in startup and interaction timing budgets (`docs/performance.md`)

## Scripting, plugins and remaining automation

- [x] Scripting API in plain JavaScript (documents, layers, pixels, text, selections, commands with recorded arguments, dialogs and forms, progress and stopping, files through pickers), one undo step per run, documented in `docs/scripting.md`
- [x] Sandbox: opaque-origin iframe with a strict content security policy running a worker, structured-clone messages, argument checks, first-run confirmation, unresponsive scripts stopped
- [x] File → Scripts → Browse (device or Puter), Scripts panel (install, run, edit in a highlighting editor, enable, shortcuts, save, delete, output), installed scripts in File → Scripts, six sample scripts
- [x] Script Events Manager (start, new, open, before/after save, export, close) for scripts and recorded actions
- [x] Statistics (images combined into an embedded object with a stack mode, optional alignment)
- [x] Lens Correction for many photos (automatic straightening and vignetting per photo, or custom settings; ZIP or Puter folder)
- [x] Create Batch Link: a link that opens Photo Studio ready to run an action on dropped photos (in place of executable droplets)

## Collaboration and review

- [x] Invite to Edit: live co-editing of a document through Puter, with presence (cursors, selected layers) and an access list
- [x] Share for Review: a read-only review link that shows the flattened image and takes comments
- [x] Comments panel: comments pinned to points or regions of the canvas, threads, replies, resolve, mentions; kept in `.photo` projects

## Assistant and generation

- [x] Assistant panel: describe an edit in words; the assistant plans it as registry commands, shows each step and runs it as one undoable change
- [x] Describe-an-edit box on the start screen (opens the image and hands the prompt to the assistant)
- [x] Generation History panel: every AI result with its prompt and settings, reusable as a new layer or a starting point

## Portrait and restoration filters

- [ ] Skin Smoothing, JPEG Artifact Removal, Photo Restoration, Colorize, Depth Blur, Style Transfer, Color Transfer and Scene Changer in one filter workspace with live previews, output as a new layer, a masked layer or a Live Filter

## Assets and provenance

- [ ] Libraries panel: colors, gradients, character styles, layer styles, brushes and graphics shared between documents, stored in Puter (or this browser)
- [ ] Content Credentials: record how an image was made (sources, edits, AI use) and attach the record to exports
- [ ] Image Assets: layers named like files (`hero.png`, `200% icon.webp`) are exported automatically on save
- [ ] Import from a camera (Import → Images from Device) and Import → Notes

## Remaining parity items

- [x] View: Actual Size, sRGB and legacy Mac RGB proof presets, separate canvas and artboard guides, New Guides From Shape, show mesh and pins, pattern tile bounds
- [x] Type: Match Font, more OpenType features (ornaments, justification alternates, proportional/tabular figures), East Asian alignment options, Convert to Block text
- [x] Layer: Convert to Linked, Refine Mask Edge
- [ ] Rotate Object (turning a flat object in depth): not planned; it needs a generative model that understands 3D shape
- [x] Help: What's New and hands-on tutorials (guided tours of real tasks)
- [x] Audio tracks on the video timeline (import, mix, render with sound)
