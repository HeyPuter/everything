# Image Assets

File → Generate → Image Assets turns on, for the current document, automatic
image files made from layer names. Any layer or group whose name looks like
one or more file names is written out as those files a moment after each edit
(and when the document is saved). The setting is saved with the `.photo`
project and can be undone like any edit.

- A document saved on Puter gets a folder next to it named after the
  document: `Poster.photo` writes into `Poster-assets/`. Only files whose
  layer changed are written again.
- Other documents keep the latest files in memory: File → Generate →
  Download Image Assets (.zip) downloads them (it also works while the
  setting is off).
- While the setting is on, the status bar shows **Assets: N** (and the number
  of problems). Click it for the list of files and problems; choosing a
  problem selects its layer.

Each file is the layer or group drawn alone (hidden layers too), with its own
opacity, blend mode, mask and effects, trimmed to its visible pixels.

## Layer names

A name is a list of outputs separated by `,` or `+`. Each output is an optional
size followed by a file name:

| Example | Result |
| --- | --- |
| `logo.png` | PNG at the layer's size |
| `logo.png8` | 8-bit palette PNG (on/off transparency) |
| `logo.png24`, `logo.png32` | same as `logo.png` |
| `photo.jpg`, `photo.jpeg` | JPEG, quality 90 |
| `photo.jpg80`, `photo.jpg80%` | JPEG, quality 80 (1–100) |
| `photo.webp`, `photo.webp60` | WebP, quality 90 or as given |
| `anim.gif` | GIF (first frame, 256 colors) |
| `shape.svg` | SVG; shape and text layers, or groups of only those |
| `200% hero.png`, `50% hero.png` | scaled by a percentage |
| `2x hero.png`, `0.5x hero.png` | scaled by a factor |
| `48x48 icon.png` | exactly 48 × 48 pixels (stretched if needed) |
| `48x? icon.png`, `?x32 icon.png` | one side fixed, the other in proportion |
| `1inx1in card.png`, `2.54cmx? a.png`, `?x25mm a.png` | physical sizes at the document resolution |
| `icons/close.png` | inside the folder `icons` |
| `hero.jpg, 50% thumbs/hero.webp` | two files from one layer |

File names may contain spaces (`my icon.png`). Folders use `/`; absolute
paths, `.` and `..`, empty folder names and the characters `: * ? " < > |`
are refused.

Names without a file-like output (`Layer 1`, `v2.final`) are ordinary names.
An output that looks like a file but does not parse is reported, for example
`icon.pngg` (unknown extension), `a.jpg101` (quality above 100), `150%% a.png`
(bad size), `a.gif80` (GIF takes no quality) or a plain word mixed into a list
(`a.png, notes`). Two layers asking for the same path are reported; the first
layer keeps it.

## Document defaults

A top-level layer whose name starts with `default` adds variants to every
asset. Variants are separated by `,` or `+`; each may have a scale (`2x`,
`50%`), a folder ending in `/` and a file-name suffix starting with `@`
(`@2x` alone also means twice the size):

| Defaults layer | `icon.png` produces |
| --- | --- |
| `default 2x hd/, 1x` | `hd/icon.png` (twice the size) and `icon.png` |
| `default @2x, 1x` | `icon@2x.png` (twice the size) and `icon.png` |
| `default 50% lo/ + 100%` | `lo/icon.png` (half size) and `icon.png` |

Variant scales multiply the size each output asks for. Only the first defaults
layer is used.

## Limitations

- Files are written, not deleted: renaming or removing a layer leaves its old
  file in the Puter folder.
- Assets are generated for the document that is active; a document in the
  background catches up when it is shown again.
- GIF assets hold one frame; palette PNG uses on/off transparency.
