# Dependency review

Updated 2026-09-16.

## Locally maintained PPTX engine

The PPTX engine and browser SVG renderer are now source code in `lib/pptx`
and `lib/pptx-preview`. Their npm packages have been removed. This is an
independent copy maintained in this repository, with no upstream syncing.
See [lib/README.md](lib/README.md) for the exact original revisions and scope.

Both source releases use the standard MIT license, copyright 2026 Yuichiro
Yamashita. Their license files are retained next to the source, and the
copyright and permission notice remains in the application's distribution.
The original source versions are PPTX 0.12.0 and Preview 0.9.1; the absorbed
files were checked against the published packages' source maps.

All former OfficeKit patches are ordinary source changes now: hidden shapes
and groups, discarded `[trash]/` parts, unique copied group IDs, empty
placeholder formatting, preset geometry, authored font resolution, and
cached layout reads. The engine preserves unsupported package parts; that
still does not establish complete rendering fidelity for every .pptx file.

Only the browser-safe preview implementation is included. The upstream
Node rasterization adapter, its font binaries, and its `fontkit`/`resvg`
dependencies are not shipped or installed. Browser previews use device fonts
and the separately licensed packaged families described below.
The app's existing PNG export uses browser rasterization of the same SVG.

Export and print add no dependencies. The PDF writer (`src/export/pdf-writer.js`),
animated GIF encoder (median-cut palettes, LZW), and the WebM and MP4
containers for WebCodecs output are original code in this repository; video
frames are encoded by the browser (WebCodecs, else MediaRecorder). PDF text
uses the standard Helvetica faces, which are referenced by name and never
embedded. Compression for PDF streams reuses the existing `fflate` dependency.

## Other dependencies

The `fflate` 0.8.3 patch makes synchronous ZIP extraction reject DEFLATE output that disagrees with the directory's declared size. Decoding stops before writing past that bound, keeping false size headers from bypassing the application's decompressed-data limit or silently truncating package parts. Archive-end detection also checks the declared comment length, matching the application validator so signature bytes inside ZIP comments do not prevent importing valid decks. Both browser and Node ESM entry points used by the PPTX library are patched. The public `inflateSync` API's documented output-buffer truncation behavior is unchanged.

`npm ci` applies the remaining fflate patch through `patch-package` during postinstall and fails if a patch cannot be applied. `patch-package` is a development dependency and is not included in the browser bundle.

Lucide uses ISC, with some Feather-derived icons under MIT. The complete Lucide notice is retained, including the Feather attribution. The favicon uses the same Lucide Presentation geometry.

Spelling uses `nspell` 2.1.5 (MIT, with its MIT dependency `is-buffer`) and the
en_US Hunspell dictionary derived from SCOWL, vendored in `public/dictionaries`
with its license file. Both are loaded only when the Spelling pane first opens,
and both notices are in the shipped third-party notices.

Third-party notices are shipped as `dist/THIRD_PARTY_NOTICES.txt` by Vite's public-directory handling.

The local preview renderer exposes an optional font-family resolver for SVG text,
including grouped text, tables, and bullets. The app retains the authored
typeface and chooses system fallbacks using the slide/layout's DrawingML
`pitchFamily` and PANOSE metadata. Previewing does not rewrite font declarations
in the PPTX. The library's default substitution remains available to other
callers.

The app supplies Raleway and Playfair Display static fonts (regular, bold,
italic and bold-italic) under the SIL Open Font License 1.1. A referenced family
is fetched from the app's own assets only when it is unavailable locally. The
same face is used for browser measurement and editing, and only styles used by
a slide are embedded in its SVG image. Presentation font declarations stay intact;
font assets are not added to exported PPTX packages. No external font service
or new runtime dependency is used. Both full licenses are in the shipped
third-party notices. Upstream URLs and SHA-256 hashes are recorded in
`src/assets/fonts/SOURCES.json`. WOFF conversion preserves every uncompressed
font-table byte, including names and copyright metadata. The font licenses
apply to those resources independently of the application's license.

The internal OpenType/EOT metadata and container layer introduces no runtime
dependency or bundled font. Its four regression TTF faces use original polygon
glyphs under the repository's MIT license. The fixture generator uses FontTools
4.65.0 (MIT) as a build tool only; no external font data is used. It requires
separate caller authorization before creating document embedding containers.

The PPTX package reader normalizes backslashes in ZIP member names at import,
so Windows-produced archives resolve their existing OPC relationships and
content-type overrides. Part bodies are unchanged, and exports use forward
slashes. The reader rejects duplicate names (including case and separator
variants) before extraction can silently replace a part. Existing invalid-path
and decompression limits still apply. No additional dependencies are needed.

The app also consults font classifications in other layouts when the current
slide omits them. Conflicting shared declarations are ignored, and local
metadata takes precedence. This lookup is lazy and cached by package and
layout bytes. Browser XML parsing is limited to candidate layouts for the
requested face. Font names and package parts remain unchanged on export;
this classification lookup adds no font assets or dependencies.

The local PPTX engine caches read-only layout views by package part and byte buffer.
Repeated placeholder lookups reuse the parsed layout; changing its bytes or
rebinding a slide refreshes the view. This avoids repeatedly parsing layout
artwork while resolving text and geometry.

TypeScript 6.0.3 (Apache-2.0) and Node type declarations (MIT) check the
absorbed source during development and CI. They are not browser dependencies.

## Checks and boundaries

- The updated lockfile reports zero known vulnerabilities. Removing the external OfficeKit packages also removes their unused Node rendering dependencies.
- The browser production build contains no UI framework or additional backend client.
- Imports are bounded before parsing. Preview SVGs are embedded as images; imported markup is never injected with `innerHTML`.
- This was a license and dependency review, not a full security audit or a legal opinion. No suspicious license restriction was found. API maturity and rendering fidelity are the practical risks.

Sources:

- https://github.com/office-kit/pptx/blob/main/LICENSE
- https://github.com/office-kit/pptx/blob/main/README.md
- https://github.com/office-kit/pptx/blob/main/package.json
- https://github.com/office-kit/pptx/blob/main/packages/preview/package.json
- https://docs.puter.com/llms.txt
- https://docs.puter.com/Utils/env/
