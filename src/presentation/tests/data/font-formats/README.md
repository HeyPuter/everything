# Original font-format regression faces

These small TrueType and CFF OpenType faces contain three original polygon glyphs
(`.notdef`, `A`, `V`). They use the MIT license and contain no
third-party font data. Their only purpose is to test font-container metadata,
all four DrawingML styles, EOT round trips and browser font loading.
`CFF.ttf` uses cubic outlines; `PreviewPrint.ttf` has native preview/print
embedding permissions; `Wide.ttf` keeps the same authored family with wider
advances to check isolation between documents. `Plus.ttf` uses a literal family
name beginning with `+` to distinguish it from the six DrawingML theme tokens.

Regenerate from the repository root with FontTools 4.65.0 (MIT licensed, build
tool only):

```sh
python3 scripts/generate-font-format-fixtures.py
```

The generator fixes font timestamps. Font files must be byte-identical on a
repeat build with that version. These fixtures do not establish visual or
native reference fidelity for the corpus presentations.

The `.mtx` variants encode the seven original TrueType faces with the published
MTX 1.0 C LZCOMP reference. The three `Complex*.ttf` companions add original
quadratic curves, multiple contours, space, nested transformed composites,
initial hint pushes, CVT and device metrics. The MTX variants exercise both
VDMX offset conventions and raw metric fallback. All source fonts and input
bytes are project MIT data. Regenerate and independently verify with FontTools:

```sh
python3 scripts/generate-mtx-font-fixtures.py
```

This generator also extracts the normative 128-case coordinate table for
independent triplet tests. It verifies reconstructed fonts with FontTools,
including outline/component coordinates, bounds, initial stacks, instruction
tails, retained table bytes and the whole-font checksum. `clang` builds the
published reference only in a temporary directory; no new runtime dependency
or reference C source is bundled in the app.
