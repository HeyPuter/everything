# Circuits

**Live app:** [circuits.puter.com](https://circuits.puter.com/)

Circuits is a free, open-source alternative to Altium Designer for schematic capture and printed circuit board layout, running in the browser on [Puter](https://developer.puter.com). Draw schematics, check them, lay out and route boards, pour copper, run design rule checks, look at the board in 3D, and export Gerber and drill files for manufacturing. Projects are stored in your own Puter cloud, or in your browser when you are not signed in.

> Circuits is in early alpha. Check fabrication files with a Gerber viewer before ordering boards.

There is no UI framework: plain ES modules, WebGL2 for both 2D and 3D rendering, a Rust kernel compiled to WebAssembly for heavy geometry, and Vite for builds.

```sh
npm install
npm run dev        # http://circuits.puter.localhost:5571/
npm test           # JavaScript tests (vitest)
npm run test:rust  # kernel tests (needs a Rust toolchain)
npm run build
```

The WebAssembly kernel is committed prebuilt at `src/kernel/kernel.wasm`, so building the app needs no Rust toolchain. After changing the Rust code, run `npm run build:wasm` (Rust 1.99 with the `wasm32-unknown-unknown` target).

## Features

- **Schematic capture**: parts from a built-in library of more than 100 components, wires and buses with corner modes, net labels, power and ground ports, ports joining sheets, junctions (added automatically at T joints), no-ERC markers, text and drawing tools. Multiple sheets, an A4 to E title block, annotation, net highlighting and an electrical rules check.
- **Board layout**: update the board from the schematic as a reviewable change list, a ratsnest that updates while you drag parts, interactive routing (45 and 90 degree corners, layer changes with vias, width cycling, stop at the first obstacle), vias, pads, fills, keep-outs, text and dimensions on 2, 4 or 6 copper layers, and board outlines with cutouts.
- **Copper pours** with clearances, thermal reliefs and island removal, computed in a background worker.
- **Checks**: online and on-demand design rule checks (clearance, shorts, widths, holes, annular rings, board edge, keep-outs, courtyards, unrouted nets).
- **Autorouter**: a multi-layer grid router for single nets or the whole board.
- **3D view** of the board with solder mask, silkscreen, finish and component bodies.
- **Outputs**: Gerber X2 for every layer, Excellon drill files, bill of materials, pick and place, netlist, SVG, printing (and PDF through the browser), and a single fabrication zip.
- **Components**: create parts from a pin list or a symbol template plus a footprint wizard (chip, SOT, SOIC/TSSOP, QFN, QFP, DIP, headers and more), or draw them in the component editor: pins, pad arrays, silkscreen and courtyard, a pin table, a 3D body and checks for pins without pads. Every project embeds the components it uses; your own components also go to "My library" for use in other projects.
- **Import**: open KiCad schematics and boards (`.kicad_sch`, `.kicad_pcb`, `.kicad_pro`); symbols, footprints, wires, labels, tracks, vias, zones and the board outline come across, and parts stay linked between schematic and board.
- **Collaboration and history**: share a cloud project with other Puter users (view or edit), and restore earlier versions kept on every save.
- **Interface**: dockable panels (Projects, Navigator, Properties, Components, Layers, Messages), menus with keyboard chords (press P then W for a wire), a command search (Ctrl+K), a heads-up coordinate display, light, dark and system themes, and layouts for desktop, tablet and phone.

## Architecture

- `src/core/`: units (integer nanometres everywhere), geometry, the undoable object store with an R-tree index.
- `src/model/`: the project format, layers, schematic and board geometry, netlist, electrical rules check, board connectivity and ratsnest, schematic-to-board sync, annotation, and the built-in library (`library/`).
- `src/render/`: the WebGL2 renderer (instanced shapes drawn with signed distance functions, so lines stay crisp at any zoom), scene builders for schematics and boards, the stroke font, and the 3D viewer.
- `src/kernel/` and `wasm/kernel/`: the Rust kernel for pours, design rule checks and autorouting, its worker and client.
- `src/editors/`: the canvas view, selection and move tool, and the schematic and board editors with their tools.
- `src/io/`: Gerber, Excellon, bill of materials, pick and place, netlist, SVG and fabrication zip exporters.
- `src/app/`: the application shell, commands and menus, keyboard handling, dialogs, settings, storage and the Puter integration.
- `src/ui/`: DOM helpers, icons, menus, dialogs, toasts and panels.

## Storage

Signed-in users' projects are `.circuits` files (JSON) in the app's folder of their Puter storage, and can be opened from or saved anywhere in it. Signed out, projects stay in the browser's private file storage. Preferences are a single small key-value entry. Projects can always be downloaded and opened from the device.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
