<p align="center"><img src="icon-128.png" width="96" height="96" alt=""></p>

<h1 align="center">Parametric</h1>

<p align="center">Feature-based parametric 3D CAD in the browser. An open-source alternative to SolidWorks, Autodesk Fusion and Autodesk Inventor.</p>

> **Early alpha.** Features may change and work could be lost. Please do not rely on Parametric for production designs yet, and keep a downloaded copy of anything important.

Parametric models solid parts the way mechanical engineers expect: you draw constrained 2D sketches on planes or faces, turn them into 3D features (extrude, revolve, fillet, shell, pattern...), and every feature stays editable in a history tree. Change a dimension and the part rebuilds.

It runs entirely in the browser. The geometry kernel is OpenCascade compiled to WebAssembly, running in a Web Worker so the interface never freezes. Storage, sign-in and settings use [Puter](https://puter.com); you can also work without an account, in which case parts are kept in your browser.

## Features

**Sketching**
- Lines, centerlines, corner and center rectangles, circles (center or 3 points), arcs (centerpoint, tangent, 3 point), polygons, straight slots, splines and points.
- Inference while drawing: snapping to points, midpoints, curves and the origin, horizontal and vertical directions, and alignment guides. Matching relations are added automatically.
- Geometric relations: coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, midpoint, collinear, symmetric and fix.
- Smart Dimension: distances (aligned, horizontal, vertical), point to line, parallel lines, angles, radius and diameter, chosen from what you select and where you place the label. Driven (reference) dimensions.
- A constraint solver with live dragging and definition status: blue geometry can still move, black is fully defined, red conflicts. The status bar shows the remaining degrees of freedom.
- Sketch fillet, trim, extend, offset, mirror, convert model edges, construction geometry.

**Features**
- Extruded boss and cut (blind, through all, mid plane, two directions, draft).
- Revolved boss and cut (full or partial, mid plane).
- Swept and lofted boss and cut.
- Fillet, chamfer (equal distance, two distances, distance and angle), shell, draft.
- Holes: simple, counterbored and countersunk, placed by clicking faces.
- Linear patterns (one or two directions), circular patterns and mirroring.
- Reference planes, STEP import.
- Open SolidWorks parts (.sldprt, SolidWorks 2003 and later) without SolidWorks: the exact solid is read from the file and becomes an imported body you can keep modeling on. The SolidWorks feature tree is not carried over.
- References to faces and edges are stored by name, so fillets and sketches on faces survive dimension changes.

**Drawings**
- A 2D drawing sheet for each part (Drawing tab in the status bar): front, top, right, left, back, bottom and isometric views projected from the solid, with hidden lines and overall dimensions.
- Sheet sizes A4 to A1, Letter and Tabloid, standard scales, drag to arrange views, title block.
- Export to PDF or SVG.

**Working with parts**
- Design tree with rollback bar, suppress, rename, hide/show, edit and delete with dependency warnings.
- Global variables and equations: type `=Width/2` in any dimension or feature value.
- Material and appearance, mass properties (mass, volume, area, center of mass, inertia), measure, section view.
- Display styles (shaded with edges, shaded, hidden lines removed or visible, wireframe), standard views, perspective.
- Save to your Puter cloud or this browser, crash recovery of unsaved work, export STEP and STL, download the part file.
- Share parts saved in your Puter cloud with other Puter users, with view or edit access. Parts shared with you appear under **Shared with me** in the Open dialog.
- Undo and redo for everything, including sketch edits.
- Light, dark and system themes. Works with mouse, trackpad, touch and keyboard, from phones to large desktop screens.

## Using it

1. Pick **Front Plane** (or any plane or flat face) and click **Sketch**.
2. Draw with the sketch tools, then add dimensions with **Smart Dimension** (D).
3. Click **Extruded Boss** (or another feature). The finished sketch becomes the profile.
4. Double-click a feature in the tree, or a face in the graphics area, to change it.

Navigation: middle or right drag rotates, Ctrl + middle drag or Shift + right drag pans, the wheel zooms at the cursor, F fits the view, Ctrl+1 to Ctrl+8 select standard views and Space opens the view orientation menu. On touch screens, drag with one finger to rotate and use two fingers to pan and zoom. Press F1 for all shortcuts.

## Development

```sh
npm install
npm run dev        # http://parametric.puter.localhost:5581/
npm test           # unit and kernel tests (Vitest)
npm run test:e2e   # browser tests (Playwright, software WebGL)
npm run build      # type check, license check, production build in dist/
```

### Architecture

| Area | Where | Notes |
|---|---|---|
| Document model | `src/model` | Plain JSON parts: features, sketches, variables. Undo/redo by snapshots. Parameters may be expressions. |
| Sketch solver | `src/sketch/solver.ts` | Minimum-norm damped Gauss-Newton per independent cluster, with a rank analysis for degrees of freedom and redundant or conflicting constraints. |
| Profiles | `src/sketch/profiles.ts` | Planar face finding on the sketch graph; nested loops alternate material and holes. |
| Geometry kernel | `src/kernel` | OpenCascade (WebAssembly) in a Web Worker. Each feature is cached under a hash of everything before it, so edits rebuild only what changed. Faces are named after the feature and sketch entity that created them. |
| Renderer | `src/render` | WebGL2: shaded meshes with per-face state in a data texture, screen-space thick edges, GPU picking with depth (asynchronous readback for hover), section clipping, render on demand. |
| Interface | `src/app`, `src/ui` | No framework. CommandManager, design tree, PropertyManager panels, sketch editor, dialogs. |
| SolidWorks import | `src/formats/sldprt` | Reads the SolidWorks container (2015+ chunk format and the older OLE2), decodes the embedded Parasolid transmit and writes it as exact STEP for the kernel. Runs in the geometry worker. |
| Platform | `src/platform` | Puter.js access, files (Puter or browser storage), theme. |

Settings are kept in a single key-value entry; part files are stored as files, never in the key-value store.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.

Third-party components and their licenses are listed in [public/licenses/THIRD_PARTY_NOTICES.txt](public/licenses/THIRD_PARTY_NOTICES.txt); the OpenCascade kernel is LGPL-2.1 and ships as a separate, replaceable WebAssembly module.
