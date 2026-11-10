# CAD

**Live app:** [cad.puter.com](https://cad.puter.com/)

Free, open-source 2D drafting and design in the browser. An open-source alternative to AutoCAD, DraftSight and BricsCAD for precise technical drawings: draw, edit, dimension, hatch, organize with layers and blocks, and exchange DWG and DXF files.

Built with vanilla JavaScript, WebGL2, Vite, [Lucide](https://lucide.dev) icons, and [Puter.js](https://docs.puter.com) as the only backend. There is no framework and no server of its own.

> **Early alpha.** Features may change and drawings could be lost. Please do not rely on it for real projects yet, and keep copies of important work.

## Features

- **Precise input**
  - Command line with autocomplete, clickable options, history and repeat (Enter or Space).
  - Coordinates as `x,y`, `@dx,dy`, `@distance<angle`, direct distance along the cursor, and `<angle` locks; feet-and-inch and fractional input in architectural units.
  - Object snaps: endpoint, midpoint, center, geometric center, node, quadrant, intersection, insertion, perpendicular, tangent and nearest, with snap markers and labels.
  - Polar tracking, ortho, object snap tracking, grid snap, and dynamic input with live length and angle readouts.
- **Drawing:** lines, construction lines and rays, polylines with arc segments and widths, rectangles (with fillets or exact dimensions), polygons, circles (center, diameter, 2 point, 3 point, tangent-tangent-radius), arcs (3 point, start-center-end, center-start-end, start-end-radius), ellipses and elliptical arcs, splines through fit points, points, donuts and revision clouds.
- **Editing:** move, copy (including linear copy arrays), rotate and scale (with reference), mirror, offset (distance or through point), trim and extend (Shift switches between them), fillet and chamfer (including whole polylines), rectangular and polar arrays, stretch, break, break at point, join, explode, lengthen, align, match properties and draw order.
- **Selection and grips:** pick, window (left to right) and crossing (right to left) selection, select all, select similar, quick select by property, rollover highlighting, and grip editing that stretches, or with Space cycles through move, rotate, scale and mirror.
- **Annotation:** single line and multiline text in an original single-stroke drafting font, linear, aligned, angular, radius, diameter and ordinate dimensions, continued and baseline dimensions, leaders, text and dimension styles.
- **Hatching:** pick a point inside any closed area (islands are detected automatically) or select closed objects. Solid fills and a library of original patterns with scale and angle.
- **Layers:** a layer manager with color, linetype, lineweight, transparency, visibility, freeze, lock and plot settings, plus quick layer tools (isolate, off, freeze, lock, make current, match).
- **Blocks:** create blocks, insert them with scale and rotation, browse them with thumbnails, rename, and purge unused ones.
- **Properties palette:** view and edit the shared properties and geometry of any selection, including polyline vertices.
- **Files**
  - Native `.cad` files (compressed JSON) that keep everything exactly.
  - DWG import (AutoCAD R13 to 2018, the format current AutoCAD versions still save) and export (DWG 2004), and DXF import and export (R2000 ASCII), all parsed and written in a Web Worker. The DWG reader and writer are written from the Open Design Specification for .dwg files.
  - Plot to PDF and PNG on standard paper sizes, fit or to scale, with a live preview. Export SVG, PNG, PDF, DWG and DXF.
  - Cloud files in your Puter drive, or files on your device. Open drawings are kept in the browser for recovery after a reload.
- **Interface:** ribbon with contextual tabs, quick access tools, drawing tabs, command search (`Ctrl+K`), context menus, a navigation bar, a status bar for drafting aids, clean screen mode, and light, dark and system themes.
- **Devices:** desktop, tablet and phone layouts, touch support (tap to pick, drag to pan, pinch to zoom), and an installable offline app shell.

## Use without an account

Everything except cloud files works without signing in: drawings can be opened from and saved to your device, and open drawings are kept in this browser between visits. Signing in with Puter adds files in your Puter drive and synced settings.

Open `/?sample` to start with a sample drawing.

## Development

```sh
npm install
npm run dev      # http://cad.puter.localhost:5173/
npm test         # unit and command tests (Vitest)
npm run build    # production build in dist/
```

## Architecture

```
src/
  main.js              boot
  app.js               open drawings, panels, files, settings, keyboard
  platform.js          Puter environment, sign-in, profile picture
  core/                framework-free model (unit tested)
    schema.js            entity and drawing data model
    drawing.js           transactional drawing with undo and redo
    spatial.js           R-tree index for picking, selection and snaps
    tessellate.js        entities to display lists (styles, blocks, text, hatches)
    geom/                geometry kernel: intersections, offset, trim, fillet, ...
    text/                stroke font and text layout
    dims.js              dimension and leader geometry
    hatch/               hatch patterns, fills and boundary detection
    units.js             length and angle formatting and parsing
  render/              WebGL2 renderer
    renderer.js          chunked GPU buffers, level of detail, highlights
    shaders.js           instanced lines with lineweights and linetypes, fills, grid
  editor/              interaction
    editor.js            prompts, snapping, tracking, selection, grips
    commands/            every command
  io/                  native files, DXF and DWG (worker), PDF, SVG, PNG, storage
  ui/                  ribbon, command line, palettes, dialogs, menus
tests/                 Vitest suites, including command integration tests
```

Model space is split into chunks of about a thousand objects, each with its own GPU buffers, so an edit only re-uploads the chunks it touches. Lines are drawn as instanced quads whose fragment shader applies linetype patterns and anti-aliasing, and positions are split into high and low float parts so drawings far from the origin stay precise. Curves are tessellated for the current zoom and refreshed in the background when the zoom changes a lot.

Drawings are stored as files (Puter FS or the device) and recovery copies in IndexedDB. The key-value store holds only one small settings record per user.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
