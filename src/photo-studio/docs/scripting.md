# Scripting

Photo Studio runs scripts written in plain JavaScript. A script can open, create,
change, export and close documents, work with layers, pixels, text and
selections, run any menu command with the same settings recorded actions use,
and ask for input with simple dialogs.

- **File → Scripts** lists installed scripts; **Browse…** and **Browse Puter…** run
  a `.js` file once (and offer to install it).
- **Window → Scripts** opens the Scripts panel: run, edit, enable or disable,
  assign a shortcut, install, save as a file or delete scripts, and read their output.
- **File → Scripts → Script Events Manager…** runs a script or a recorded action
  when Photo Studio starts or a document is created, opened, saved, exported or closed.

Six sample scripts are installed the first time Photo Studio starts (Add
Watermark, Add Border, Rename Layers by Pattern, Random Color Swatches, Export
Layers at Several Sizes, Grid from Open Documents). Edit them freely; Restore
Sample Scripts in the panel menu puts back any you removed.

## Security model

Scripts are programs you install, so they run apart from the app:

- Each run gets a hidden `<iframe sandbox="allow-scripts">` (an opaque origin)
  whose content security policy is `default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:`.
  The script runs in a dedicated worker started by that iframe. It cannot reach
  Photo Studio's page, DOM, cookies, local storage, IndexedDB or the Puter
  session, and it has no network access (`fetch`, `XMLHttpRequest`, WebSocket and
  remote imports are blocked).
- The only way out is the `studio` API: structured-clone messages that Photo
  Studio checks before acting. Files are read or written only through pickers the
  user operates; every dialog a script shows names the script.
- A script installed from a file or browsed asks for confirmation before its first
  run. Scripts run by events must be installed, enabled and already confirmed.
- A script that does not answer for 30 seconds while computing (set another limit
  with a `// @timeout <seconds>` header line) is stopped. **Stop** on the run
  indicator stops a script at its next API call.

## Writing a script

A script is the body of an async function: use `await` at the top level, and
`return` to stop early. Header comments name it:

```js
// @name Add Watermark
// @description Adds a copyright line in a corner.
const doc = await studio.documents.active();
if (!doc) return studio.ui.alert('Open a document first.');
const layer = await doc.addLayer({ kind: 'text', text: '© 2026', size: 32, color: '#ffffff' });
await layer.moveTo(doc.width - layer.bounds.width - 20, doc.height - layer.bounds.height - 20);
await layer.set({ opacity: 70 });
```

`console.log`, `console.warn` and `console.error` write to the Scripts panel's
output and the editor. Uncaught errors stop the script and report the line.

### Undo

All changes a run makes to a document become **one undo step** named after the
script. `await studio.history.checkpoint('Label')` closes the current step under
that label and starts a new one; `await studio.history.setGrouping(false)` keeps
each change as its own step from then on.

### Progress and stopping

`studio.ui.progress(fraction, message)` shows progress (0–1, or `null` for
indeterminate) on the run indicator. Long loops should call
`studio.checkCancelled()` (or read `studio.cancelled`) so Stop takes effect
between steps; any API call made after Stop rejects.

## API reference

All methods return promises. Objects returned by the API (documents, layers) are
snapshots: call `refresh()` for current values. Sizes and positions are document
pixels; opacity is 0–100; colors are `"#rrggbb"` strings or `[r, g, b]` arrays.

### `studio`

| Member | Description |
| --- | --- |
| `apiVersion` | `1` |
| `script` | `{ id, name }` of the running script |
| `event` | For runs started by the Script Events Manager: `{ name, documentId, documentName }`; otherwise `null` |
| `cancelled`, `checkCancelled()` | Whether Stop was pressed; `checkCancelled()` throws to end the script |
| `sleep(ms)` | Wait (up to 60 s per call) |
| `app.info()` | `{ name, apiVersion, foreground, background }` (current colors) |
| `app.message(text)` | Show a status message |

### Documents

| Method | Description |
| --- | --- |
| `studio.documents.active()` | The active document, or `null` |
| `studio.documents.list()` | Every open document |
| `studio.documents.get(id)` | A document by ID |
| `studio.documents.create({ name, width, height, resolution, background })` | New document; `background` is `"white"`, `"black"`, `"transparent"` or a color |
| `studio.documents.open({ multiple })` | Shows a file chooser (device or Puter) and opens the chosen files |

A document has `id`, `name`, `width`, `height`, `resolution` (pixels per inch),
`mode`, `bitsPerChannel`, `active`, `saved` and `fileName`, and these methods:

| Method | Description |
| --- | --- |
| `activate()` | Make it the active document |
| `layers()` | Every layer, top to bottom as in the Layers panel (children follow their group) |
| `layer(idOrName)` | One layer, or `null` |
| `selectedLayers()`, `selectLayers(layers)` | Read or change the layer selection |
| `addLayer(options)` | New layer above the selection (see below) |
| `composite(rect?)` | The visible image as `{ x, y, width, height, data }` (RGBA bytes) |
| `selection()` | Bounds of the selection, or `null` |
| `select(shape, operation?)` | `shape` is `{ type: "rect" \| "ellipse", x, y, width, height }`; `operation` is `"replace"`, `"add"`, `"subtract"` or `"intersect"` |
| `selectAll()`, `deselect()`, `invertSelection()` | Selection commands |
| `selectionMask()`, `setSelectionMask(mask, operation?)` | Read or set the selection as `{ x, y, width, height, data }` with one byte (0–255) per pixel |
| `run(commandId, arg?)` | Run a command on this document |
| `export({ format, quality, width, height, scale, name })` | Encoded image `{ name, type, extension, width, height, data }`; formats `png`, `jpeg`, `webp`, `avif`, `tiff`, `bmp`, `gif`, `tga` |
| `save()` | Save as File → Save does (asks where the first time) |
| `close({ discard })` | Close; with `discard: true` unsaved changes are dropped without asking |
| `undo()`, `redo()` | Step through the document's history |

`addLayer` options: `kind` (`"pixel"` default, `"text"`, `"group"`, `"fill"`),
`name`, `opacity`, `blendMode`, `visible`, `above` (a layer) or `inside` (a group).
Pixel layers take `fill` (a color) and `rect` to start filled; text layers take
`text`, `size` (pixels), `color`, `font`, `bold`, `italic`, `align` and `x`, `y`
(top-left of the text); fill layers take `color`.

### Layers

A layer has `id`, `documentId`, `name`, `kind` (`pixel`, `text`, `shape`,
`group`, `fill`, `adjustment`, `embedded`, `image`, `artboard`, `frame`),
`visible`, `opacity`, `fillOpacity`, `blendMode`, `bounds`, `parentId`,
`depth`, `clipped`, `locked`, `background`, `hasMask`, `hasStyle`, `text` (text
layers) and `children` (group child IDs, top first), and these methods:

| Method | Description |
| --- | --- |
| `refresh()` | Current values |
| `set({ name, visible, opacity, fillOpacity, blendMode, clipped, locked })` | Change properties |
| `rename(name)`, `show()`, `hide()` | Shortcuts for `set` |
| `move(dx, dy)`, `moveTo(x, y)` | Move by an offset, or so the bounds start at a point |
| `arrange(where)` | `"top"`, `"bottom"`, `"up"`, `"down"`, `{ above: layer }`, `{ below: layer }` or `{ inside: group }` |
| `duplicate()`, `remove()`, `select()` | |
| `pixels(rect?)` | `{ x, y, width, height, data }` (RGBA bytes, straight alpha) of the layer's bounds or a rectangle |
| `setPixels(image, x?, y?)` | Write `{ width, height, data }` into a pixel layer at a position |
| `getText()`, `setText(text \| { text, size, color, font, bold, italic })` | Text layers |
| `setStyle(style \| null)` | Layer effects, e.g. `{ dropShadow: { distance: 8, opacity: 50 }, stroke: { size: 3, color: "#fff", position: "outside" } }`. Effects: `dropShadow`, `innerShadow`, `outerGlow`, `innerGlow`, `bevel`, `satin`, `colorOverlay`, `stroke`; `true` uses the defaults |
| `children()` | Layers inside a group |
| `export(options)` | As `document.export`, for this layer alone (trimmed to its content unless `trim: false`) |

### Commands

`studio.commands.run(id, arg)` runs any menu command by ID with the active
document. The argument is the one a recorded action stores (see an action's
steps after recording, or save actions to a file), so a command that shows a
dialog applies `arg` directly instead. For example:

```js
await studio.commands.run('adjust.desaturate');
await studio.commands.run('filter.apply.gaussian-blur', { params: { radius: 4 } });
// Portrait & Restore: list the filters to turn on with their settings.
await studio.commands.run('filter.portrait-restore', { params: { filters: [{ id: 'restore', enabled: true, params: { dust: 60 } }, { id: 'skin', enabled: true }] } });
```

Portrait & Restore filter IDs are `skin`, `jpeg`, `restore`, `colorize` (with
`hints: [{ x, y, color, radius }]`, positions from 0 to 1), `transfer`,
`depth`, `style` and `scene`; AI options and layer-based depth need the
workspace and are skipped when run with settings.

Scripts cannot run the scripting commands themselves, the Assistant
(`assistant.*`) or Generation History (`generations.*`); those run only from
the person's own click.

`studio.commands.list()` returns `{ id, label, enabled }` for every command
a script can run.
Commands that manage scripts cannot be run from scripts.

### Dialogs

| Method | Description |
| --- | --- |
| `studio.ui.alert(message, title?)` | |
| `studio.ui.confirm(message, title?)` | `true` for OK |
| `studio.ui.prompt(message, value?, title?)` | The text, or `null` when cancelled |
| `studio.ui.form(title, fields, { submit, message }?)` | An object of values by field name, or `null` when cancelled |
| `studio.ui.progress(fraction, message?)` | Progress on the run indicator |

Form fields are `{ name, label, type, value, min, max, step, options }` with
`type` one of `text`, `number`, `range`, `checkbox`, `select`, `color`,
`textarea`. Numbers come back as numbers and checkboxes as `true`/`false`;
`options` is a list of `[value, label]` pairs.

### Files and images

| Method | Description |
| --- | --- |
| `studio.files.open({ accept, multiple })` | Shows a chooser (device or Puter); returns `[{ name, type, data }]` with `data` a `Uint8Array` |
| `studio.files.save(name, data, type?)` | Offers to download the file or save it to Puter; `data` is a string, `ArrayBuffer` or `Uint8Array` |
| `studio.files.saveAll(files, zipName)` | Several `{ name, data }` files as one ZIP |
| `studio.image.create(width, height, fill?)` | A blank (or filled) `{ width, height, data }` image |
| `studio.image.encode(image, { format, quality, width, height, scale })` | Encode RGBA pixels |

## Examples

Export every visible layer as a PNG in a ZIP:

```js
const doc = await studio.documents.active();
const files = [];
for (const layer of await doc.layers()) {
  if (!layer.visible || layer.kind === 'group') continue;
  const out = await layer.export({ format: 'png' });
  files.push({ name: `${layer.name}.png`, data: out.data });
}
await studio.files.saveAll(files, `${doc.name}-layers.zip`);
```

Invert the red channel of a pixel layer:

```js
const doc = await studio.documents.active();
const [layer] = await doc.selectedLayers();
const img = await layer.pixels();
for (let i = 0; i < img.data.length; i += 4) img.data[i] = 255 - img.data[i];
await layer.setPixels(img, img.x, img.y);
```

Stamp the name of each new document (run it from the Script Events Manager on
New Document):

```js
const doc = await studio.documents.get(studio.event.documentId);
await doc.addLayer({ kind: 'text', text: doc.name, size: 18, x: 12, y: 12 });
```

## Other automation

- **File → Scripts → Statistics…** combines images (files, Puter files or open
  documents), optionally aligned first, into one embedded object with a stack
  mode (mean, median, …), which can be changed later.
- **File → Automate → Lens Correction…** corrects many photos at once. Automatic
  settings measure each photo: the rotation that makes strong near-vertical and
  near-horizontal edges straight (filling the frame afterwards) and the darkening
  of the corners. Custom settings apply the Lens Correction filter's values to
  every photo. Results download as a ZIP or go to a Puter folder.
- **File → Automate → Create Batch Link…** makes a link (or bookmark) that opens
  Photo Studio ready to run a recorded action on the photos dropped into it and
  download the results as a ZIP. The link carries the action's steps and output
  settings, never files. Links can only hold document edits: steps that run
  scripts, open windows or save files are refused, and nothing runs until the
  user adds photos and presses Run.
