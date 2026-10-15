# Third-party software

All versions are pinned exactly in `package.json`. License texts of every package bundled into the
application are copied to `public/licenses/` and ship with the production build. No proprietary,
commercial-only, source-available or custom-licensed packages are used.

## Bundled into the application

| Package | Version | License | Source | Purpose |
| --- | --- | --- | --- | --- |
| three | 0.186.1 | MIT | github.com/mrdoob/three.js | WebGL2 rendering; also the bundled `fflate`, USDC parser and Collada loader from `three/examples` (MIT) |
| three-mesh-bvh | 0.9.15 | MIT | github.com/gkjohnson/three-mesh-bvh | Ray casting / picking acceleration, sculpt BVH |
| three-gpu-pathtracer | 0.0.24 | MIT | github.com/gkjohnson/three-gpu-pathtracer | Path-traced render engine |
| three-bvh-csg | 0.0.18 | MIT | github.com/gkjohnson/three-bvh-csg | Boolean modifier |
| xatlas-web | 0.1.0 | MIT | github.com/mozillareality/xatlas-web | Lightmap / smart UV packing |
| @dimforge/rapier3d-compat | 0.21.0 | Apache-2.0 | github.com/dimforge/rapier | Rigid body physics (loaded on demand) |
| fzstd | 0.1.1 | MIT | github.com/101arrowz/fzstd | Zstandard decompression of `.blend` files |
| opentype.js | 1.3.4 | MIT | github.com/opentypejs/opentype.js | Font outlines for text objects |
| @fontsource/inter | 5.3.0 | SIL OFL 1.1 | github.com/fontsource/font-files (Inter by Rasmus Andersson) | Interface and 3D text font |
| @fontsource/jetbrains-mono | 5.2.8 | SIL OFL 1.1 | github.com/fontsource/font-files (JetBrains Mono) | Monospace font (console, text editor) |

## Loaded at runtime (not bundled)

| Package | Version | License | Source | Notes |
| --- | --- | --- | --- | --- |
| Pyodide | 314.0.7 | MPL-2.0 (CPython: PSF License) | cdn.jsdelivr.net/pyodide/v314.0.7/full/ | Python scripting. Downloaded unmodified from the CDN the first time Python is used; JavaScript scripting works offline without it. |

## Build and test tooling (not shipped)

| Package | Version | License |
| --- | --- | --- |
| vite | 8.3.0 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| vitest | 5.0.1 | MIT |
| @playwright/test | 1.63.0 | Apache-2.0 |
| happy-dom | 20.14.5 | MIT |
| prettier | 3.9.8 | MIT |
| gltf-validator | 2.0.0-dev.3.10 | Apache-2.0 (test-only glTF validation) |
| @types/three, @types/node, @types/opentype.js | 0.186.0, 26.6.2, 1.3.8 | MIT |

## Interoperability data

- The app is an independent, clean-room implementation. It contains no source code, icons, themes,
  text, startup files or other assets from Blender (GPL-2.0-or-later).
- For file and scripting compatibility (`.blend` import, `bpy`-style scripts), some generated tables
  (`src/nodes/shader/data.gen.ts`, `src/geonodes/data.gen.ts`, `src/io/blend/nodeprops.gen.ts`,
  compositor node data) list node, socket and property *names, identifiers, enum items and default
  values* of the public `bpy` API. These are interface facts needed to read and write compatible
  data, not expressive code; they are flagged here for legal review.
- Test fixtures in `tests/fixtures/` (`.blend`, `.glb`, `.fbx`, `.usd*`, `.abc`, …) were generated for
  this project by the scripts in the same folders or written by hand.
- "Blender" is a trademark of the Blender Foundation. It is used only to name the `.blend` file
  format; this project is not affiliated with or endorsed by the Blender Foundation.
