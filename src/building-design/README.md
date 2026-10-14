<p align="center"><img src="icon-128.png" width="96" height="96" alt=""></p>

<h1 align="center">Building Design</h1>

<p align="center">Building information modeling in the browser. An open-source alternative to Autodesk Revit, ArchiCAD and Vectorworks.</p>

> **Early alpha.** Features may change and project data could be lost. Please do not rely on Building Design for real projects yet, and keep copies of important work.

Building Design models a building as real elements on levels: walls with layered constructions, doors and windows that cut their own openings, floors, ceilings, roofs, columns, beams, stairs, railings, furniture and fixtures, and rooms that measure themselves. Every view is generated from the one model, so a change in a plan shows up in sections, elevations, 3D, schedules and sheets at once.

It runs entirely in the browser, with [Puter](https://puter.com) for sign-in, cloud files and sharing. You can use it without an account: projects are kept in your browser and can be saved to your device.

## Features

**Modeling**
- Walls drawn as chains, rectangles or along picked lines, with a choice of location line (centerline, exterior or interior face), base and top constraints, and typed lengths. Walls join cleanly at corners, T junctions and multi-wall nodes, and their layers (finish, structure, insulation, air space...) show in plan at fine detail.
- Curtain walls with a regular grid of mullions and glass panels.
- Doors (single, double, sliding, pocket, bifold, overhead, cased opening) and windows (fixed, casement, double hung, sliding, awning, picture) hosted in walls, with swing and facing controls. Rectangular wall openings.
- Floors and ceilings from a picked room or building outline, a rectangle, or a sketched boundary. Footprint roofs with a slope per edge: hips, gables and shed roofs come out of the same model.
- Columns, beams, straight stairs with automatic riser counts and handrails, and railings.
- A library of furniture, casework, plumbing fixtures, appliances, planting and lighting. Furniture placed near a wall turns its back to it.
- Rooms placed by clicking or automatically, bounded by walls, columns and room separation lines, with live area, perimeter and volume.
- Levels and grids.

**Editing**
- Selection by click, window (left to right) and crossing (right to left), Tab to cycle overlapping elements, select all instances.
- Drag to move (joined walls stay joined; doors slide along their wall or move to another wall), grips on wall ends, slab corners and section lines, flip controls, and editable temporary dimensions.
- Move, copy, rotate, mirror (pick or draw an axis), array, align, offset, trim/extend to corner or to a reference, split, pin, match type, copy and paste.
- Object snaps (endpoints, midpoints, intersections, perpendicular, nearest), angle and length increments, and alignment with nearby points.
- Undo and redo for everything.

**Views and documentation**
- Floor and ceiling plans with cut plane, detail level, underlay of the level below, room color fill and per-view visibility of categories and elements.
- 3D views with an orientation cube, orbit, perspective or orthographic projection, section box and five visual styles.
- Elevations and sections drawn from the model with cut elements filled, levels and grids annotated.
- Aligned dimensions that follow the walls they measure, text, tags and detail lines.
- Schedules of doors, windows, rooms, walls, floors, furniture, columns and stairs, with field selection, sorting, grouping, totals, in-place editing and CSV export.
- Sheets with a title block and placed views.
- Temporary hide and isolate, reveal hidden elements, thin lines.

**Files**
- Projects (.bdp) saved to your Puter cloud storage or to your device; open projects are kept in the browser so work survives a reload.
- Share projects with other Puter users for viewing or editing.
- Export to IFC (IFC4, for other BIM software), glTF and OBJ (3D), DXF (plans), PDF, SVG and PNG (drawings and sheets), and CSV (schedules).

**Interface**
- Ribbon with contextual tabs, options bar, Properties palette with type selector and type editor (including wall, floor, roof and ceiling layer structures), Project Browser, view tabs, view control bar and status bar.
- Two-letter keyboard shortcuts (for example WA wall, DR door, WN window, MV move), command search (Ctrl+K), context menus and a full keyboard path through the panels.
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

Lengths are millimetres internally and shown in the project's units. Settings are kept in a single Puter key-value record; projects are always stored as files, never in the key-value store.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.

Third-party libraries: [earcut](https://github.com/mapbox/earcut) (ISC) and [Lucide](https://lucide.dev) icons (ISC).
