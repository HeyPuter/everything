# Architecture

This app is a browser-based 3D creation suite. Everything is plain TypeScript (no framework),
rendered with **three.js** (WebGL2). The world is **Z-up**, units are meters, angles are radians
internally. Property names follow the widely used `bpy` scripting conventions
(`location`, `rotation_euler`, `hide_render`, …) so animation paths, scripting and importers map 1:1.

```
src/
  app/        App runtime (doc, undo, operators, modal), keymaps, preferences
  data/       Document types (types.ts), factories (defaults.ts), RNA paths (rna.ts), COW snapshots
  mesh/       Polygon mesh helpers (mesh.ts) and primitives
  eval/       Depsgraph: transforms, constraints, modifiers, armature/IK, curves, textures
  anim/       F-curves, keyframes, drivers, NLA evaluation
  render/     Shared WebGL renderer (engine.ts), scene sync, materials, grid, helpers, images
  editors/    Editors (view3d/, properties/, outliner.ts, timeline.ts, …)
  ui/         Virtual DOM (h.ts), widgets, menus/pies/popovers, screen/areas, shell, props helpers
  ops/        Operators (object, view3d, screen, transform, data, wm)
  object/     Object Mode menus and object data management: vertex groups, shape keys, material
              slots, modifiers, hooks, relations/data transfer, instancing (collection/verts/faces),
              speakers, quick effects
  io/         Native .p3d format, autosave, legacy import, file operators + format registry,
              fonts.ts (text outlines), formats/ (glTF, FBX, OBJ, STL, PLY, USD, Collada, Alembic),
              blend/ (.blend reader)
  modes/      Edit modes: editmesh/ (mesh), armature/ (edit + pose), curve/, lattice/, text/
  nodes/      Node registry, shader nodes + GLSL compiler, generic node editor (editor/)
  geonodes/   Geometry Nodes nodes, field evaluator, NODES modifier, Geometry Node Editor
              curves/: spline types (Bézier/NURBS/Catmull-Rom attributes + evaluation), curve, text,
              import, Grease Pencil and gizmo nodes; placed in the Add menu with `place()` (curves/menu.ts)
  spreadsheet/ Spreadsheet editor
  compositor/ Compositor nodes (GPU), Compositor editor, render post-processing
  animation/  Dope Sheet, Graph Editor, Drivers, NLA editors and their operators
  paint/      Sculpt, Vertex/Weight/Texture Paint, voxel remesh, automatic weights
  physics/    Rigid bodies (Rapier, lazy-loaded), cloth, soft body, particles, fields, smoke
  hair/       Curves (hair) objects: data (doc.hair_curves), strand display / render tubes, Edit Mode,
              Sculpt Curves brushes (brushmath.ts is pure), conversions, Deform Curves on Surface;
              particle/: Particle Edit mode for hair particle systems (edited keys on the system)
  render/final/ Path tracer, raster engine, F12/animation render, Image Editor, color management;
              props/ holds the Render, Output, View Layer and camera-data properties panels
  sequencer/  Video Sequencer (strips, effects, preview, audio)
  tracking/   Movie Clip Editor, 2D tracking, stabilization, Follow Track constraint
  mask/       Mask data-blocks (bezier splines with feather, shape keys, track parenting),
              rasterization, the clip editor's mask mode, compositor Mask node
  greasepencil/ Grease Pencil objects, Draw/Edit/Sculpt modes, 2D Animation workspace
  scripting/  bpy-style API (JavaScript + Pyodide Python), Text Editor, Console, Info, Preferences
  assistant/  AI assistant sidebar (Puter AI): agent loop, scene snapshot, tools over the scripting API
  edit/, modifiers/, storage/document.ts, core/   legacy polygon kernels kept for reuse
                                                 (unwrap/UV) and the legacy .3d.json parser
```

## Core concepts

### Document (`data/types.ts`)
`DocumentData` holds data-block tables (`objects`, `meshes`, `materials`, `node_groups`, `actions`, …)
keyed by id, plus `scene` (frame range, render settings, tool settings, active object, master
collection) and `mode`. Objects reference data by id (`ob.data`).

Meshes are polygon meshes: `positions` (xyz per vertex), `offsets` (face corner offsets),
`indices` (vertex per corner), `uvs` (per corner), optional per-corner `seams/sharp/creases`,
per-face `smooth/material_index`, per-vertex `select_vert/hide_vert`, `vertex_groups`+`weights`,
`shape_keys`, `color_attributes`. Helpers are in `mesh/mesh.ts` (`buildMesh`, `toPolys`,
`edgeTopology`, `vertexFaces`, `cornerNormals`, `triangulatePoly`).

**Typed arrays are immutable after an undo push.** To mutate in place during an operation use
`cow(owner, 'key')` from `data/cow.ts` (copies once per undo step), or simply assign a new array.

### App (`app/app.ts`)
`import { app } from './app/app'`. Key members:
- `app.doc`, `app.graph` (Depsgraph), `app.activeObject`, `app.selectedObjects()`, `app.isVisible(id)`
- `app.changed(...kinds)` – schedule re-evaluation and redraw. Kinds: `'doc' | 'select' | 'frame' | 'ui' | 'mode' | 'view' | 'geometry'`
- `app.pushUndo(label)` – push an undo snapshot (call after a direct edit that was not done via an operator)
- `app.run(idname, props?, { invoke?, event? })` – run an operator
- `app.report(type, message)` – status bar / Info log message
- `app.startModal(handler)` / `app.endModal('FINISHED'|'CANCELLED')`
- `app.setFrame(n)`, `app.playing`

### Operators
```ts
import { registerOperators } from '../app/app';
registerOperators([{ idname: 'mesh.subdivide', label: 'Subdivide', props: [...PropDef], poll: (ctx) => bool,
  exec: (ctx, props) => 'FINISHED' | 'CANCELLED' | void, invoke?: (ctx, props) => ..., undo?: boolean }]);
```
- After `exec`/`invoke` returns `FINISHED` (or `undefined`), the App pushes an undo step named
  `label` and, if the operator has visible `props`, offers them in the **Adjust Last Operation**
  panel (re-runs `exec` on the previous state with new props). Operators must therefore be
  deterministic given props.
- `undo: false` for view/UI operators.
- Modal tools: `invoke` calls `app.startModal({...})` and returns `'RUNNING_MODAL'`. The modal
  `label` becomes the undo step name when it finishes.

### Keymaps (`app/keymap.ts`)
`addKeys('Keymap Name', [{ key: 'G', shift?, ctrl?, alt?, op: 'transform.translate', props?, when?: () => bool, menu?: () => MenuItem[] }])`.
Key names are event names: `'A'..'Z'`, `'ONE'..`, `'NUMPAD_1'`, `'TAB'`, `'SPACE'`,
`'DEL'`, `'ESC'`, `'RET'`, `'F1'..`, `'LEFT_ARROW'`, … An editor lists the keymaps it uses in
`editor.keymaps` (priority order); `Frames`, `Screen`, `Window` always apply. Ctrl also matches Cmd.

### Editors (`ui/screen.ts`)
```ts
registerEditor({ id: 'GRAPH', label: 'Graph Editor', icon: 'graph', group: 'Animation', create: (area, state) => new GraphEditor(area, state) });
```
An `Editor` has `el` (fills the area), `header(): Child` (vdom for the header), `update(kinds)`,
`resize?()`, `dispose()`, `keymaps`, `onKey?(e): boolean`, `serialize?()`. The area header (editor
type dropdown) is drawn by the framework. Workspaces (`defaultWorkspaces()` in `ui/screen.ts`)
reference editor ids: `VIEW_3D, IMAGE_EDITOR, UV, SHADER, GEOMETRY, COMPOSITOR, DOPESHEET,
TIMELINE, GRAPH, DRIVERS, NLA, TEXT, CONSOLE, INFO, OUTLINER, PROPERTIES, FILE_BROWSER,
SPREADSHEET, PREFERENCES`. An editor id with no registration falls back to the 3D view.

### UI toolkit
- `ui/h.ts`: `h(tag, attrs, ...children)` + `patch(container, vnodes)` keyed vdom. Event handlers are
  `onclick`, `onpointerdown`, etc. `ref: (el) => …` runs once on creation.
- `ui/widgets.ts`: `numberField`, `checkbox`, `enumMenu`, `enumRow`, `colorSwatch`, `textField`,
  `button`, `opButton`, `panel` (collapsible), `decorator`.
- `ui/props.ts`: data-bound split rows: `num(owner, key, label, opts)`, `bool`, `enumProp`,
  `colorProp`, `vecProp`, `textProp` — they push undo and call `app.changed('doc')`.
- `ui/menu.ts`: `openMenu(items, anchor)`, `openPie(title, items8, x, y, key)`, `openPopover`,
  `openSearch`, `promptText`. `MenuItem` supports `op`/`props`, `action`, `submenu`, `separator`,
  `heading`, `checked`, `active`, `shortcut`, `icon`.
- `ui/icons.ts`: original SVG icons, `icon('name')`. Add new icons there (16×16 grid, use
  `class="f"` fill / `class="s"` stroke so theme colors apply).
- Theme: `src/theme.css` (CSS variables). Reuse existing classes (`panel`, `split-row`,
  `hdr-row`, `hdr-menu`, `hdr-toggle`, `btn`, …).

### Properties editor tabs
`registerTab({ id, label, icon, group, poll, draw: (p) => Child })` from
`editors/properties/properties.ts`. Modifier panels get type-specific fields from
`modifierFields[type]` and extra UI via `modifierExtraUI[type]` (`editors/properties/stack.ts`).

### Evaluation (`eval/depsgraph.ts`)
`app.graph.get(id)` → `EvalObject { world: Matrix4, mesh?: EvalMesh, pose?, visible, geomVersion }`.
Modifiers: `registerModifier({ type, label, category, icon, defaults, apply(mesh, mod, ctx), deps?,
timeDependent?, deformOnly? })` (`eval/modifiers.ts`). `MeshBuilder` (`eval/meshbuild.ts`) builds
evaluated meshes. `app.graph.simulationPositions.set(objectId, Float32Array)` injects simulated
vertex positions (physics caches) before the modifier stack.

### Rendering
`render/context.ts` exports `renderContext` (engine, scene sync, env maps). `render/engine.ts` owns
the single WebGL2 renderer; viewports implement `ViewportRenderer` and draw into scissored rects.
Materials for Material Preview / Rendered come from `viewportMaterial(doc, materialId)`
(`render/pbr.ts`); a node-based compiler plugs in through `setMaterialCompiler`. World environment:
`render/world.ts`. Images: `render/images.ts` (`imageTexture`, `imageCanvas`, `touchImage`).

### 3D Viewport extension points
`editors/view3d/hooks.ts` (`editModeHooks.pointer/pick/box/svg/...`), `modemenus.ts`
(per-mode header menus), `toolbar.ts` (`toolsByMode`, `extraToolLists`, `toolSettingsRenderers`),
`sidebar.ts` (`sidebarTabs`, `itemPanels`), `ops/modes.ts` (`modeHandlers[mode].enter/exit`),
`ops/transform.ts` (`transformProviders` for G/R/S on custom data), `ops/view3d.ts` (`frameHooks`).

### Files
`io/files.ts`: `registerFormat({ id, label, extensions, import?(file), export?({selectedOnly}) })`
adds entries to File ▸ Import/Export. Native format: `io/native.ts`.

### Workspaces
`ui/screen.ts`: `defaultWorkspaces()` and `registerWorkspaceTemplate(category, () => Workspace)`
(the "+" tab menu); layouts are built with `A(type)`, `H(ratio, a, b)`, `V(ratio, a, b)`, `dock()`.

### Other extension points
- `eval/modifiers.ts` `registerModifier`, `editors/properties/stack.ts` `modifierFields` (panel rows)
- `editors/properties/properties.ts` `registerTab`, `tabs.ts` `objectExtraPanels`, `dataTabDrawers` (Object Data tab per object type)
- `editors/properties/uilist.ts` `uiList(..., { specials, up, down })` for list specials menus and reordering
- `object/instancing.ts` `objectDuplis` (instances an object shows; drawn via `SyncedObject.duplis`)
- `editors/view3d/draw.ts` `drawHooks`, `render/scene.ts` `sceneSyncHooks`
- `render/final` `renderPostHooks` (compositor), sequencer frame hooks in `job.ts`
- `app/keymap.ts` `keyInputHooks` (raw text input, e.g. Text Edit Mode)
- `nodes/editor/context.ts` `registerNodeEditorProvider` (Shader, Geometry, Compositor editors; optional
  `linkViewer` for Ctrl Shift click, `viewPanels` / `optionsPanels` for the sidebar's View / Options tabs).
  Tree commands behind the node editor's menus are pure functions in `nodes/treeops.ts` and `nodes/iface.ts`.
- Screen: `ui/layout.ts` (pure split/join/swap of the layout tree), `ui/screenops.ts` (area
  operators); header buttons with class `hdr-menu` that open a menu on pointerdown are picked up
  by F3 menu search and the collapsed-menus button (`captureMenuItems` in `ui/menu.ts`)
- Top bar menus live in `ui/topbar.ts` (`fileNewTemplates`, `wm.call_menu` names); recent files,
  the startup file and auto save snapshots in `io/session.ts`; `itemContextHooks` (`ui/menu.ts`)
  add entries to the right-click menu of menu items
- `ui/props.ts` `propertyAnimMenuHook` (right-click menu of keyframe decorators), `anim/keyingsets.ts`
  `propertyAnimExtraItems`; `editors/properties/tabs.ts` `sceneKeyingPanel`, `armatureDataPanels`
- Animation editors (`animation/animeditor.ts`): `selectables()` feeds box/circle/lasso selection,
  `overlay` draws transient circle/lasso/slider readouts, `snapTo()`/`snapHeader()` snapping options;
  key-shaping logic lives in `animation/fcurvetools.ts` (pure) and its operators in `graphtools.ts`

### Registration
Feature modules are imported for side effects from `src/modules.ts` (`registerModules()`).
They run before the `App` instance exists: use `onAppReady(fn)` (`app/app.ts`) for anything that
needs `app` (e.g. `app.subscribe`).

## Conventions
- Never copy code, text, icons or other assets from any other application; implement everything
  independently. Socket/property/operator *names* follow public `bpy` identifiers for compatibility.
- Prefer small focused files under the feature's own directory.
- Every visible control must work; don't add menu entries for operators that don't exist.
- Use `app.report('ERROR', …)` for recoverable failures instead of throwing to the UI.
