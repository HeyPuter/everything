<p align="center"><img src="icon-128.png" width="96" height="96" alt=""></p>

<h1 align="center">Parametric</h1>

<p align="center"><strong>Live app:</strong> <a href="https://parametric.puter.com/">parametric.puter.com</a></p>

<p align="center">Feature-based parametric 3D CAD and CAM in the browser. An open-source alternative to SolidWorks, Autodesk Fusion and Autodesk Inventor.</p>

> **Early alpha.** Features may change and work could be lost. Please do not rely on Parametric for production designs yet, and keep a downloaded copy of anything important.

Parametric models solid parts the way mechanical engineers expect: you draw constrained 2D sketches on planes or faces, turn them into 3D features (extrude, revolve, fillet, shell, pattern...), and every feature stays editable in a history tree. Change a dimension and the part rebuilds.

It runs entirely in the browser. The geometry kernel is OpenCascade compiled to WebAssembly, running in a Web Worker so the interface never freezes. Storage, sign-in and settings use [Puter](https://puter.com); you can also work without an account, in which case parts are kept in your browser.

## Features

**Sketching**
- Lines, centerlines, corner and center rectangles, circles (center or 3 points), arcs (centerpoint, tangent, 3 point), polygons, straight slots, splines and points.
- Inference while drawing: snapping to points, midpoints, curves and the origin, horizontal and vertical directions, and alignment guides. Matching relations are added automatically.
- Geometric constraints (relations): coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, midpoint, collinear, symmetric and fix. Pick one in the Constrain group of the Sketch tab and click the geometry it applies to, or select geometry first and choose from the constraints that fit.
- Smart Dimension: distances (aligned, horizontal, vertical), point to line, parallel lines, angles, radius and diameter, chosen from what you select and where you place the label. Driven (reference) dimensions.
- A constraint solver with live dragging and definition status: blue geometry can still move, black is fully defined, red conflicts. The status bar shows the remaining degrees of freedom.
- Sketch fillet, trim, extend, offset, mirror, construction geometry.
- External geometry: Convert Entities projects model edges, faces and vertices into the sketch, and a sketch point or curve can be constrained to a model edge or vertex directly. Projected geometry stays linked to the model: when an earlier feature changes, it moves with the model and the sketch geometry constrained to it follows.

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

**Surfaces**
- A Surfaces tab: extruded, revolved, swept and lofted surfaces from open or closed sketch curves, planar surfaces from a closed sketch or a loop of edges, offset surfaces (a distance of 0 copies faces) and filled patches.
- Trim surfaces with a plane, a sketch or another surface (keep a side, or click the pieces to keep), extend them past an edge, and knit them together, into a solid when they close a volume.
- Thicken a surface into the part or cut with it (Thickened Cut), cut the part with a surface, or delete faces of the solid to work on it as a surface (or delete and patch them).
- Surface bodies are shown in a warm tint beside the solid, can be hidden from the design tree, are picked and referenced like the solid's faces and edges (sketch on a planar surface face), go into STEP files as shells and are left out of the solid's mass properties.

**Sheet metal**
- Sheet Metal tab: Base Flange from a closed profile (a flat plate) or an open line and arc chain (bent at each corner), with the part's thickness, bend radius, K-factor (or bend allowance or deduction) and relief type kept on it and editable from the Sheet-Metal row of the design tree. A later Base Flange is a Tab on a face of the sheet.
- Edge Flange on one or more edges: length from the outer or inner virtual sharp or the bend, any angle, material inside or outside or bend outside, offsets with rectangular or obround bend reliefs. Sketched Bend along a line on a flat face, and closed or open Hems.
- Flatten shows the flat pattern (bend allowance π/180 · angle · (R + K·T)) with dashed bend lines, bend notes and the overall size; holes and cuts through flat regions are included. Export the flat pattern to DXF with outline, cuts and bend lines on their own layers.

**Weldments**
- Structural Member (Weldments tab): sweep standard profiles along sketch lines and arcs from one or more sketches, in groups. ISO (EN 10219 tubes and pipe, EN 10056 angles, UPE channels, IPE and HE A beams, flat and round bar) and ANSI (HSS, standard pipe, angles, C channels, W shapes, bar) sizes are generated from their standard dimensions, with corner radii.
- Corner treatments within a group (end miter, end butt 1 and 2, with a gap), and trimming and extending between groups. Profile rotation, mirror and pierce point.
- Trim/Extend members to a planar face or to other members (planar or coped), End Cap on tube and pipe ends, Gusset plates between two faces, and solid Fillet Bead welds along inside corners.
- Cut list in the design tree: identical members grouped with quantity, description, length, end angles and mass, exported as CSV.

**Assemblies**
- File > New Assembly. Insert Components places parts from your cloud, this browser or your device (a part file or a STEP model); insert a part several times for several instances (bracket<1>, bracket<2>). The first component is fixed; the others float.
- Mates: coincident, parallel, perpendicular, distance, angle, concentric, tangent and lock, between faces, edges and the assembly planes, with aligned or anti-aligned alignment and values that take equations. The Mates folder in the design tree edits, flips, suppresses and deletes them. The status bar shows whether the assembly is under, fully or over defined; conflicting mates are marked.
- Drag a component (Alt+drag, or Rotate Component, turns it): it moves only as its mates allow, so a lid on a hinge pin turns about the pin. Fixed components do not move.
- Exploded view steps, interference detection with the overlapping volumes, a bill of materials (item, part, quantity, material; copy or download as CSV), mass properties with each part's material, measure, section view, and STEP (components as named solids) and STL export of the whole assembly.
- An assembly references its part files and keeps a copy of each, so it opens even when a part file is moved, shared or downloaded. Open Part edits a component's part; save it and go back, and the assembly takes the change (Update Parts reads the part files again).

**Assistant**
- An AI design assistant in the right sidebar (Ctrl+J, or the sparkle button). Describe a part or a change ("a 100 × 60 × 8 mm plate with four M5 holes and rounded corners", "make the wall 3 mm", "fillet the top edges") and it builds it with the same features you use: sketches with exact geometry, relations and dimensions, extrudes, revolves, holes, fillets, chamfers, shells, patterns, mirrors, planes, lofts, sweeps and drafts, global variables and equations.
- It reads the part precisely (feature parameters, sketch entities, faces and edges by name, measurements, mass properties), checks every change by rebuilding, undoes steps that would break a feature, and looks at the model to verify its work.
- Attach files to a message (paperclip, paste or drop): photos and sketches of a part, dimensioned drawings and datasheets as images or PDFs, DXF outlines or CSV tables. It reads sizes and geometry from them.
- Everything it changes in one message is a single undo step. It runs on Puter AI (Claude Opus 5.5).

**Drawings**
- A 2D drawing sheet for each part: **Make Drawing** on the Drafting ribbon tab or the File menu (or the Drawing tab in the status bar). Front, top, right, left, back, bottom and isometric views projected from the solid, with hidden lines and overall dimensions.
- Projected views that stay aligned with their parent, section views (horizontal, vertical or aligned cutting line, the cut face hatched, labelled A-A with arrows), detail views (a magnified circle with its letter and scale) and auxiliary views. Per-view scale, caption, hidden and tangent edges; deleting a view takes the views made from it along, after a warning.
- Annotations: Smart Dimension on the sheet (horizontal, vertical, aligned, radius, diameter and angle) measured from the model's named edges, so dimensions follow the model when it changes and are marked when their geometry is gone; center marks and hole centerlines (automatic or by hand), centerlines, notes with leaders and hole callouts.
- Sheet sizes A4 to A1, Letter, Tabloid, ANSI C and D, standard scales, third or first angle projection, title block with material, scale, date, revision, sheet number and the projection symbol.
- Export to PDF, SVG or DXF.
- Assembly drawings: Make Drawing (or the Drawing tab in the status bar) in an assembly lays out its views on an A3 sheet with the bill of materials (item number, part number, material, quantity) on the title block; the table follows the assembly as components are added or removed. Views show the components where the mates put them, or exploded (a checkbox on the view); section views cut every component and hatch each its own way. Balloons label components with their item number: Auto Balloon numbers every component a view shows, Balloon numbers the one whose edge you click.
- Sheet metal drawings: a Flat Pattern view (Drafting tab, or Add view) shows the flat outline and cuts, the bend lines (dashed up, chain lines down) with their notes ("UP 90° R 1") and the overall size; it can be dimensioned and detailed like any view.
- Weldment drawings: a Cut List table (Annotation tab) with item, quantity, description, length and end angles, which follows the part, and balloons on members numbered from it.

**CAM (machining)**
- A CAM tab turns the part into CNC programs. A setup says where the part sits on the machine: the direction the tool comes from (any side of the part, picked from a list or from a flat face), a turn about it, the stock (a margin around the part or a fixed block), the work origin (a corner or the centre of the stock's top, or the part's origin), the work offset (G54 to G59) and the clearance and retract heights. A second setup usually machines the other side.
- A tool library of flat, ball and bull nose end mills, drills and chamfer mills with their flutes, speeds and feeds, kept with the part.
- 2D operations: Face (the top of the stock down to the part), 2D Contour (round the outside through the full height, with lead-in arcs, a ramp down along the wall and holding tabs), 2D Pocket (down to picked floors, offset or zigzag passes, entering by a helix, a ramp or a plunge), Drill (drilling, deep peck and chip breaking cycles on every hole of the drill's size or those picked; through holes found by themselves) and Bore (helical milling of holes larger than the tool).
- 3D operations: 3D Rough (the stock around the whole part in levels, with stock to leave and extra levels at its flat areas), Parallel finishing and Waterline finishing, with ball, bull nose or flat end mills.
- Climb or conventional milling, stock to leave on walls and floors, feeds and speeds per operation. The toolpath shows while an operation is edited, with its machining time; operations are listed under CAM in the design tree, marked when the part changed since they were generated.
- Every toolpath is checked against the part; Simulate cuts the stock operation by operation and plays it back with the tool, coloured by what is finished, what is left and where the part would be cut, and reports rapid moves through the stock and material above the flutes.
- Post Process writes G-code for Fanuc, Haas, LinuxCNC, Mach3/Mach4 or Grbl, in millimetres or inches, with arcs (G2/G3, helical) and drilling cycles (G81, G82, G83, G73) where the controller has them; preview it, copy it or download it.

**Working with parts**
- Design tree with rollback bar, suppress, rename, hide/show, edit and delete with dependency warnings.
- Global variables and equations: type `=Width/2` in any dimension or feature value.
- Material and appearance, mass properties (mass, volume, area, center of mass, inertia), measure, section view.
- Display styles (shaded with edges, shaded, hidden lines removed or visible, wireframe), standard views, perspective.
- Save to your Puter cloud or this browser, crash recovery of unsaved work, export STEP and STL, download the part file.
- Open parts, STEP and SolidWorks files from the Puter desktop (double-click or Open with), or drag them onto the app from a Puter folder window or your computer. Files dragged onto the assistant go with your next message.
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
| Assemblies | `src/model/assembly.ts`, `src/assembly`, `src/app/assembly`, `src/kernel/assembly.ts` | Assembly documents embed their parts as blobs. Rigid-body mate solver: damped least squares over mate residuals, six degrees of freedom per floating component, rank analysis for the definition, conflicts found by adding mates one at a time. Components' meshes are placed on the main thread (dragging needs no kernel call); the worker keeps the placed solids for measure, interference, mass, projection and export. |
| Sketch solver | `src/sketch/solver.ts` | Minimum-norm damped Gauss-Newton per independent cluster, with a rank analysis for degrees of freedom and redundant or conflicting constraints. |
| Profiles | `src/sketch/profiles.ts` | Planar face finding on the sketch graph; nested loops alternate material and holes. |
| Geometry kernel | `src/kernel` | OpenCascade (WebAssembly) in a Web Worker. Each feature is cached under a hash of everything before it, so edits rebuild only what changed. Faces are named after the feature and sketch entity that created them. |
| Renderer | `src/render` | WebGL2: shaded meshes with per-face state in a data texture, screen-space thick edges, GPU picking with depth (asynchronous readback for hover), section clipping, render on demand. |
| Interface | `src/app`, `src/ui` | No framework. CommandManager, design tree, PropertyManager panels, sketch editor, dialogs. |
| SolidWorks import | `src/formats/sldprt` | Reads the SolidWorks container (2015+ chunk format and the older OLE2), decodes the embedded Parasolid transmit and writes it as exact STEP for the kernel. Runs in the geometry worker. |
| CAM | `src/model/cam.ts`, `src/cam`, `src/app/cam` | Toolpaths are generated in a worker of their own from a fine mesh of the part, in the setup's work coordinates. Drop-cutter (`src/cam/dropcutter.ts`) gives the lowest height a flat, ball, bull nose or conical cutter can reach at a point (face, edge and corner contacts, exact where a closed form exists). Where the tool can be at a height is where that is lower: its boundary is traced by marching squares with each crossing refined by bisection on the drop-cutter, and the passes inside it are offsets of a distance transform, cut from the innermost out. Parallel finishing follows drop-cutter heights along lines. The simulation lowers a height map of the stock along every move. Post processors write the moves with arcs fitted to them. |
| Assistant | `src/assistant` | Tool-calling agent on Puter AI. Tools work on the document through a host interface (the app, or the kernel in Node for tests); each change rebuilds and is checked, failing steps are reverted, and a message's changes are squashed into one undo step. |
| Platform | `src/platform` | Puter.js access, files (Puter or browser storage), theme. |

Settings are kept in a single key-value entry; part files are stored as files, never in the key-value store.

## License

Parametric is licensed under the [GNU Affero General Public License v3.0](LICENSE). Third-party libraries retain their own licenses.

Third-party components and their licenses are listed in [public/licenses/THIRD_PARTY_NOTICES.txt](public/licenses/THIRD_PARTY_NOTICES.txt); the OpenCascade kernel is LGPL-2.1 and ships as a separate, replaceable WebAssembly module.
