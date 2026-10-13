# Third-party components and assets

Every dependency, font, icon set, model, dataset or other asset that ships with
Photo Studio is recorded here with its source and license before it is used.
Nothing here is a legal opinion; entries marked **Review** need a human check.

| Component | Version | Used for | Source | License | Notes |
| --- | --- | --- | --- | --- | --- |
| ag-psd | 31.0.2 | PSD/PSB read and write | https://github.com/Agamnentzar/ag-psd | MIT | Loaded on demand |
| lucide | ^0.468.0 | Interface icons | https://lucide.dev | ISC (portions MIT from Feather) | |
| pako | 2.1.0 | Deflate for PSD/project data | https://github.com/nodeca/pako | MIT AND Zlib | |
| yjs | 13.6.33 | Shared documents (merging concurrent edits, per-person Undo) and the room worker | https://github.com/yjs/yjs | MIT | Loaded on demand; bundled into `public/worker/photo-studio-worker.js` |
| lib0 | 0.2.119 | Encoding helpers used by yjs | https://github.com/dmonad/lib0 | MIT | Dependency of yjs |
| isomorphic.js | 0.2.5 | Platform shims used by lib0 | https://github.com/dmonad/isomorphic.js | MIT | Dependency of lib0 |
| pathkit-wasm | 1.0.0 | Vector path booleans and stroking | https://skia.org | BSD-3-Clause | Loaded on demand |
| png (Rust crate) | 0.17 | Lossless PNG encoding in Wasm | https://crates.io/crates/png | MIT OR Apache-2.0 | |
| Inter (font) | 4.001 | Bundled typeface (sans serif), variable 100-900 + italic | https://github.com/rsms/inter (via https://github.com/google/fonts/tree/main/ofl/inter) | OFL-1.1 (no Reserved Font Name) | Latin subset, opsz pinned to 14; WOFF2 for display, WOFF for outlines; `public/fonts/inter/OFL.txt`; 338 KB |
| Crimson Pro (font) | 1.003 | Bundled typeface (serif), variable 200-900 + italic | https://github.com/Fonthausen/CrimsonPro (via google/fonts `ofl/crimsonpro`) | OFL-1.1 (no Reserved Font Name) | Latin subset; WOFF2 + WOFF; `public/fonts/crimson-pro/OFL.txt`; 301 KB |
| JetBrains Mono (font) | 2.211 | Bundled typeface (monospace), variable 100-800 + italic | https://github.com/JetBrains/JetBrainsMono (via google/fonts `ofl/jetbrainsmono`) | OFL-1.1 (no Reserved Font Name) | Latin subset; WOFF2 + WOFF; `public/fonts/jetbrains-mono/OFL.txt`; 214 KB |
| Bebas Neue (font) | 2.000 | Bundled typeface (display), 400 only | https://github.com/dharmatype/Bebas-Neue (via google/fonts `ofl/bebasneue`) | OFL-1.1 (no Reserved Font Name) | Latin subset; WOFF2 + WOFF; `public/fonts/bebas-neue/OFL.txt`; 40 KB |
| Caveat (font) | 2.000 | Bundled typeface (handwriting), variable 400-700 | https://github.com/googlefonts/caveat (via google/fonts `ofl/caveat`) | OFL-1.1 (no Reserved Font Name) | Latin subset; WOFF2 + WOFF; `public/fonts/caveat/OFL.txt`; 185 KB |
| fontTools (build tool only) | 4.25.0 | Subsetting the bundled fonts to Latin (`pyftsubset`, `varLib.instancer`); not shipped | https://github.com/fonttools/fonttools | MIT | Fonts avoid Reserved Font Names so subsetted copies may keep their names (OFL section 3) |
| SCOWL (Spell Checker Oriented Word Lists) | 2020.12.07 | English word list for Edit → Check Spelling (levels 10-60 of the English and American words, proper names, upper-case words, contractions and abbreviations, about 123,000 entries ordered from common to rare) | http://wordlist.aspell.net (https://downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz) | SCOWL copyright notice (permissive, MIT-like; includes public-domain sources) | Gzip-compressed at `public/dictionaries/en-US.txt.gz` (350 KB); full notice in `public/dictionaries/SCOWL-LICENSE.txt`; loaded only when spell checking runs |
