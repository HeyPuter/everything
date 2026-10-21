<p align="center"><img src="icon-128.png" width="96" height="96" alt=""></p>

<h1 align="center">Building Design</h1>

<p align="center">Building information modeling in the browser. An open-source alternative to Autodesk Revit, ArchiCAD and Vectorworks.</p>

> **Early alpha.** Features may change and project data could be lost. Please do not rely on Building Design for real projects yet, and keep copies of important work.

Building Design models a building as real elements on levels: walls with layered constructions, doors and windows that cut their own openings, floors, ceilings, roofs, columns, beams, stairs, railings, furniture and fixtures, and rooms that measure themselves. Every view is generated from the one model, so a change in a plan shows up in sections, elevations, 3D, schedules and sheets at once.

It runs entirely in the browser, with [Puter](https://puter.com) for sign-in, cloud files and sharing. You can use it without an account: projects are kept in your browser and can be saved to your device.

## Features

**Modeling**
- Walls drawn as chains, rectangles or along picked lines, with a choice of location line (centerline, exterior or interior face), base and top constraints, and typed lengths. Walls join cleanly at corners, T junctions and multi-wall nodes, and their layers (finish, structure, insulation, air space...) show in plan at fine detail.
- Curtain walls with a regular grid of mullions and glass panels; grid lines placed per wall, mullion segments removed or restored, and panels made solid, empty or doors.
- Wall sweeps and reveals (cornices, string courses, skirtings, grooves) along either face, stopping at openings.
- Doors (single, double, sliding, pocket, bifold, overhead, cased opening) and windows (fixed, casement, double hung, sliding, awning, picture) hosted in walls, with swing and facing controls. Rectangular wall openings.
- Floors and ceilings from a picked room or building outline, a rectangle, or a sketched boundary. Footprint roofs with a slope per edge: hips, gables and shed roofs come out of the same model.
- Walls can attach their tops to a roof and follow it when the roof changes.
- Shaft openings that cut floors, ceilings and roofs through a range of levels.
- Columns (architectural and structural), beams, braces, beam systems that fill a bay, straight, L-shaped and U-shaped stairs with automatic riser counts, landings and handrails, ramps and railings.
- Openings by face in floors, roofs and ceilings, curtain grids placed per wall, model lines, reference planes and work planes.
- Foundations: isolated footings (one by one or under every column), wall foundations and foundation slabs.
- Building services: ducts, pipes, cable trays and conduits drawn at a height and coloured by system, with air terminals, mechanical and electrical equipment, lighting, devices and plumbing fixtures.
- Site: toposurfaces through points with contour lines, property lines, parking and site components. Massing: in-place masses with gross floor areas, and walls, floors, roofs and curtain systems made from their faces.
- A library of furniture, casework, plumbing fixtures, appliances, planting and lighting. Furniture placed near a wall turns its back to it.
- Rooms placed by clicking or automatically, bounded by walls, columns and room separation lines, with live area, perimeter and volume. Area plans with area boundaries, for gross and rentable areas.
- Model and detail groups that update every instance when one is edited, phases (existing, demolished, new) with phase filters, and design options for exploring alternatives side by side.
- Global parameters with formulas that element parameters can follow, and dimension constraints: equal spacing (EQ) and locked distances that hold as the model changes.
- Spaces and zones with first heating and cooling load estimates, and a check for duct and pipe ends that connect to nothing.
- Levels and grids.

**Editing**
- Selection by click, window (left to right) and crossing (right to left), Tab to cycle overlapping elements, select all instances.
- Drag to move (joined walls stay joined; doors slide along their wall or move to another wall), grips on wall ends, slab corners and section lines, flip controls, and editable temporary dimensions.
- Move, copy, rotate, mirror (pick or draw an axis), array, align, offset, scale, trim/extend to corner or to a reference, split (with a gap), pin, match type, create similar, copy and paste (also to other levels).
- Object snaps (endpoints, midpoints, intersections, perpendicular, nearest), angle and length increments, and alignment with nearby points.
- Selection filter by category, saved selections, selection by id, and a warnings list.
- Undo and redo for everything.

**Views and documentation**
- Floor and ceiling plans with cut plane, detail level, underlay of the level below, room color fill and per-view visibility of categories and elements.
- 3D views with an orientation cube, orbit, perspective or orthographic projection, section box, five visual styles, and shadows from the sun at the project's location, date and time. Render makes presentation images with materials, shadows and sky, up to 4K.
- Tile views side by side, each with its own visibility.
- Project base point and survey point for site coordinates; scope boxes that views crop to.
- Elevations and sections drawn from the model with cut elements filled, levels and grids annotated.
- Callouts, drafting views, legends and view duplication with or without detailing; crop regions with grips.
- Aligned, linear, angular, radial and diameter dimensions, spot elevations, coordinates and slopes, text with leaders, tags (by mark, type, material or keynote), detail lines, arcs, detail components, insulation, filled regions, revision clouds, colour fill legends, north arrows and scale bars.
- Visibility/Graphics with category and per-element overrides (colour, weight, halftone and, in 3D, transparency), rule-based filters, view templates and project-wide object styles.
- Tags in plans, elevations and sections, tread numbers on stairs, and arc length dimensions.
- Schedules of doors, windows, rooms, areas, walls, floors, ceilings, roofs, ramps, furniture, columns, stairs, ducts, pipes and foundations, plus material takeoffs, sheet lists and view lists, with field selection (including project parameters), sorting, grouping, filters, totals, in-place editing and CSV export.
- Sheets with a title block, placed views and a revision table.
- Temporary hide and isolate, reveal hidden elements, thin lines.
- Raster images placed in views to trace over or present.

**Files**
- Projects (.bdp) saved to your Puter cloud storage or to your device; open projects are kept in the browser so work survives a reload.
- Share projects with other Puter users for viewing or editing, and work on them together: saving merges others' changes element by element so nobody overwrites anyone, changes others save appear while you work, and worksets divide the model into parts that views can show or hide.
- Link other projects, read-only, for coordination; transfer types, materials, templates and other standards from another project.
- Import DXF drawings into a plan, section or sheet as detail lines and text, to trace over or annotate.
- Export to IFC (IFC4, for other BIM software), glTF and OBJ (3D), DXF (plans), PDF, SVG and PNG (drawings and sheets), and CSV (schedules).

**Interface**
- Ribbon with contextual tabs, options bar, Properties palette with type selector and type editor (including wall, floor, roof and ceiling layer structures), Project Browser, view tabs, view control bar and status bar.
- Two-letter keyboard shortcuts (for example WA wall, DR door, WN window, MV move) that you can reassign, export and import, command search (Ctrl+K), context menus and a full keyboard path through the panels.
- An Options dialog for preferences such as tooltip detail, selection behaviour and live updates.
- Light, dark and system themes. Works with mouse, trackpad, touch and keyboard, on desktops, tablets and phones.

## Getting around

1. Start a metric or imperial project from the Home screen, or open the sample house.
2. Draw walls with **Wall** (WA). Click to start, click again to end each segment; type a number to enter a length. Esc ends the chain.
3. Add doors (DR) and windows (WN) by moving over a wall. Space flips them.
4. Create a **Floor** or **Roof** by clicking a wall of the building, then **Finish**.
5. Place rooms (RM), then open the **3D View**, an elevation or a section from the Project Browser.

Navigation: the wheel zooms at the cursor, the middle button pans. In 3D, drag with the right button (or Shift and the middle button) to orbit. On touch screens, pinch to zoom, drag with two fingers to pan and with one finger to orbit in 3D. Press F1 for help and shortcuts.

## Development

```sh
npm install
npm run dev        # http://building-design.puter.localhost:5173/
npm test           # unit tests (Vitest)
npm run build      # production build in dist/
```

Open `/?sample` to start with the sample house.

### Architecture

| Area | Where | Notes |
|---|---|---|
| Document | `src/core/doc.js` | One store of immutable items (elements, types, views, materials) with transactions, previews, undo and redo. |
| Model logic | `src/core` | Wall joins (`walls.js`), room boundaries from a planar arrangement (`rooms.js`), footprint roofs as the lower envelope of slope planes (`roof.js`), stairs, procedural families, schedules, sheets. Framework-free and unit tested. |
| Geometry | `src/core/build3d.js`, `src/core/plan.js` | Each element builds a 3D mesh with feature edges, and plan graphics (cut fills with hatch patterns, line weights, dashes, text) for the view it is drawn in. |
| Scene | `src/core/scene.js` | Caches meshes and plan graphics per element and rebuilds only what an edit touched, by comparing each result's inputs. |
| Rendering | `src/render` | WebGL2. Plans: instanced, antialiased lines with weights and dash patterns, hatched fills, drawn in layers from chunked GPU buffers. 3D: chunked meshes, screen-space edges, clip planes, transparency, GPU picking. A per-element state texture handles selection, hover, hiding and halftone without touching geometry. |
| Views | `src/views` | Plan, 3D/elevation/section, schedule and sheet controllers; one shared WebGL canvas plus a 2D overlay for text and feedback. |
| Editing | `src/editor` | Tools, snapping, grips, temporary dimensions. |
| Interface | `src/ui` | No framework: ribbon, panels, dialogs, menus. |
| Files | `src/io` | Native files, Puter storage, recovery, and the IFC, glTF, OBJ, DXF, PDF and SVG writers. |
| Collaboration | `src/core/sync.js`, `src/io/sync.js` | Element-level three-way merge of the shared project file against the copy last synchronized; polling for others' saves; worksets in `src/core/worksets.js`. |

Lengths are millimetres internally and shown in the project's units. Settings are kept in a single Puter key-value record; projects are always stored as files, never in the key-value store.

## License

This app, including all its contents, modules, and components, is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Third-party libraries included in this app may be subject to their own licenses.

Third-party libraries: [earcut](https://github.com/mapbox/earcut) (ISC) and [Lucide](https://lucide.dev) icons (ISC).
