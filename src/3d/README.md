# 3D

A Blender alternative that runs entirely in the browser: modeling, sculpting, UV editing, shader /
geometry / compositor nodes, animation and rigging, physics, path-traced and real-time rendering,
video editing, motion tracking, Grease Pencil and scripting, with nothing to install. It is written
from scratch in TypeScript on top of three.js (WebGL2).

This project is independent: it is a clean-room implementation that contains no Blender source code,
icons, themes or other assets, and it is not affiliated with or endorsed by the Blender Foundation.
"Blender" is a trademark of the Blender Foundation.

## Run locally

Prerequisites: **Node.js 24 LTS** and npm, and a browser with WebGL2 (any current Chrome, Edge,
Firefox or Safari).

```sh
npm ci
npm run dev          # open the printed URL
```

`?factory-startup` in the URL starts from the default scene without restoring the autosaved
session.

## Build and test

```sh
npm run build        # type check + production build into dist/
npm run preview      # serve the production build
npm test             # unit tests (vitest)
npx playwright install chromium
npm run test:e2e     # browser tests (Playwright); E2E_BASE_URL=… reuses a running server
npm run check        # all of the above
```

## What's included

**Interface.** Topbar with the default workspaces (Layout, Modeling, Sculpting,
UV Editing, Texture Paint, Shading, Animation, Rendering, Compositing, Geometry Nodes, Scripting) and
a "+" menu with 2D Animation, Motion Tracking and Video Editing templates. Areas can be split, joined
and switched to any editor (Shift+F1…F12). Menus, pie menus, F3 search, redo panel (F9), tooltips,
status bar and the default keymap (left-click select, numpad / emulated numpad navigation).

**Editors.** 3D Viewport, Outliner, Properties, Timeline, Dope Sheet, Graph Editor, Drivers,
Nonlinear Animation, Shader Editor, Geometry Node Editor, Compositor, Spreadsheet, Image Editor,
UV Editor, Video Sequencer, Movie Clip Editor, File Browser, Text Editor, Python Console, Info,
Preferences.

**Objects and modes.** Meshes, curves (Bézier/NURBS/poly), text (Inter font), armatures, lattices,
empties (including reference/background images), lights, cameras, Grease Pencil. Object, Edit
(mesh, curve, armature, lattice, text), Pose, Sculpt, Vertex/Weight/Texture Paint and Grease Pencil
Draw/Edit/Sculpt modes.

**Modeling.** Selection tools (click, box, circle, lasso, loops/rings, linked, shortest path …),
transforms with constraints, numeric input, proportional editing and element snapping (vertex,
edge, edge center, face, volume, grid, increment), extrude, inset, bevel, loop cut and slide, knife,
spin, bisect, rip, merge, dissolve, fill/bridge, subdivide, symmetrize, normals tools, UV unwrap
and projections, and the modifier stack (Array, Bevel, Boolean, Build, Decimate, Edge Split,
Geometry Nodes, Mask, Mirror, Remesh, Screw, Solidify, Subdivision Surface, Triangulate, Weld,
Wireframe, Armature, Cast, Curve, Displace, Hook, Lattice, Shrinkwrap, Simple Deform, Smooth,
Laplacian Smooth, Warp, Wave, Weighted Normal, Smooth by Angle, and physics modifiers).

**Sculpt and paint.** Around 20 sculpt brushes with symmetry, masking and voxel remesh; vertex,
weight and texture painting; automatic armature weights.

**Nodes.** About 80 shader nodes compiled to GLSL (Principled BSDF and friends, textures, color and
vector utilities), Geometry Nodes with fields, instances and a viewer, and a GPU compositor with
a full compositing node set and backdrop.

**Animation and rigging.** Keyframes, keying sets, auto keying, F-curve modifiers, drivers, NLA,
motion paths, Bake Action, armatures with IK and bone constraints, shape keys, object constraints.

**Physics.** Rigid bodies (Rapier), cloth, soft body, particles (emitter and hair), force fields,
collision and a smoke/fire domain solver, all cached on the timeline.

**Rendering.** Solid / Material Preview / Rendered viewport shading, a progressive path tracer with
denoising and a real-time raster engine (AO, bloom, soft shadows, motion blur), color management
(Standard, AgX, Filmic, Khronos PBR Neutral), F12 stills and animation renders to PNG/JPEG/WebP
sequences or WebM video, render passes, compositing and sequencer output.

**Video editing and tracking.** Video Sequencer with scene, movie, image, sound, color, text,
adjustment, meta and effect strips plus audio mixdown; Movie Clip Editor with 2D feature tracking,
feature detection, 2D stabilization and the Follow Track constraint.

**Scripting.** A `bpy`-style API usable from JavaScript (offline) or Python (Pyodide, loaded on
first use), Text Editor with run script, Python Console, script-registered operators and panels.

**AI assistant.** A sidebar (open by default; the topbar's Assistant button or Window › AI Assistant
shows and hides it, and the choice is remembered) where you describe what to build or change. It runs
on Puter AI: it reads the scene, writes and runs scripts against the `bpy`-style API (a failing script
is rolled back), looks up the API, takes viewport screenshots to check its work, and reads attached
reference images, PDFs and text files. Everything it changes for one message is a single undo step.

**Files.** Native `.p3d` project format with autosave/recovery; import of `.blend` files written by
Blender 2.80–5.x; import/export of glTF/GLB, FBX, OBJ/MTL, STL, PLY and USD (USDA/USDC/USDZ);
import of Collada and Alembic; legacy `.3d.json` scenes from earlier versions of this app.

## Known limitations

- No camera solving (motion-tracking reconstruction), Multires, Dyntopo, Cycles-only features such
  as volumes and subsurface scattering in the path tracer, or EEVEE-specific effects.
- Python scripting covers a documented subset of `bpy`; it needs network access once per session
  to download Pyodide.
- `.blend` import covers the active scene and common data; unsupported data is reported, not lost
  silently. Export to `.blend` is not supported.
- See the module headers and the pull-request description for per-feature limitations.

## Layout of the code

See `ARCHITECTURE.md`.

## License and third-party software

See `LICENSE` and `THIRD_PARTY_NOTICES.md`. License texts of bundled dependencies are in
`public/licenses/`.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
