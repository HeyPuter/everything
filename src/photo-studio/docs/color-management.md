# Color management in Photo Studio

The color engine lives in `src/color/` (ICC parsing, transforms, generated
profiles, mode conversions, proofing). The user interface for it lives in
`src/features/color/`. This page describes what the interface does and the
trade-offs behind it.

## Where things are

| Feature | Command IDs | Code |
| --- | --- | --- |
| Color picker | `color.pick-foreground`, `color.pick-background`, `color.pick-layer-color` | `features/color/picker.ts` (`pickColor`) |
| Color Settings | `edit.color-settings` (Mod+Shift+K) | `features/color/settings.ts` |
| Assign / Convert to Profile | `edit.assign-profile`, `edit.convert-profile` | `features/color/settings.ts` |
| Image modes | `image.mode-*`, `image.color-table` | `features/color/modes.ts`, `convert.ts` |
| Bit depth | `image.depth-8`, `image.depth-16`, `image.depth-32` | `features/color/docops.ts` |
| Proofing | `view.proof-custom`, `view.proof-cmyk`, `view.proof-srgb`, `view.proof-legacy-rgb`, `view.proof-monitor-rgb`, `view.proof-colors` (Mod+Y), `view.gamut-warning` (Mod+Shift+Y) | `features/color/proof.ts` |
| Mode-aware export | `file.export-cmyk-tiff`, `file.export-mode-tiff`, `file.export-mode-png` | `features/color/export.ts`, `encode.ts` |
| Swatch libraries | `swatches.library-*`, `swatches.harmony-*` | `features/color/swatches.ts` |

Other features can call `pickColor(e, initial, title)` (from
`features/color` or `features/color/picker`), `exportModeTiff(e, 'cmyk'?)`,
`exportModePng(e)` and `applyOpenPolicy(e)`.

## Profiles

A document's RGB values are interpreted in `doc.iccProfile` (base64 ICC). An
untagged document (`iccUntaggedProfile`, or no profile) is treated as sRGB, or
linear sRGB for 32-bit documents, matching the renderer.

- **Assign Profile** changes only the tag. Values stay the same, so the image
  looks different. The dialog previews the choice on the canvas.
- **Convert to Profile** changes values so colors look the same in the
  destination RGB profile, using the chosen rendering intent and black point
  compensation. It converts pixel layers, embedded images stored in document
  space and shape colors stored in document space. Colors defined in sRGB
  (solid fills, text, sRGB embedded images) already keep their appearance
  through the renderer, so they are left alone. Gradients, patterns, layer
  styles and adjustment layers are not converted. The status message lists
  any layers that were skipped.
- **Color Settings** chooses the working RGB, CMYK and Gray profiles (built-in
  or loaded `.icc` files), the default intent and black point compensation, the
  profile policy for opened documents and the gamut warning color. Settings are
  stored in this browser. Profiles loaded from files last for the session.
- **Policies.** When a document is opened from a file, its profile is compared
  with the working RGB space. Preserve keeps it, Convert converts the pixels
  (one undo step), and Off discards the profile. The optional prompts ask what
  to do with mismatched or missing profiles. Default settings never change a
  document.

The generated CMYK profiles take a few seconds to build, so they are built in a
worker (`profile-worker.ts`). Code that needs them awaits `ensureProfile(ref)`.

## Image modes: how they are stored

The compositor, tiles, filters and painting tools all work on document RGB.
Rewriting them for gray, CMYK, Lab or indexed storage would touch every
feature. Instead, `PhotoDocument.mode` records the mode, and `modeData` records
what the mode needs: the output profile, palette, bitmap settings or duotone
inks. Pixels stay RGB and each conversion **constrains** them to the mode's
gamut:

| Mode | What conversion does | What export writes |
| --- | --- | --- |
| Grayscale | Every pixel becomes neutral (document RGB to working gray and back) | 8-bit gray TIFF or PNG with the gray profile |
| CMYK | Pixels round-trip through the CMYK profile, so every color is printable | CMYK TIFF (photometric 5, InkSet CMYK) with the CMYK profile |
| Lab | A round trip through 8-bit CIELAB | CIELab TIFF (photometric 8) |
| Indexed | The image is flattened into one layer of palette colors | Palette PNG with tRNS |
| Bitmap (from Grayscale) | Flattened to black and white at the output resolution (threshold, pattern, diffusion or halftone screen) | 1-bit PNG, or gray TIFF |
| Duotone (from Grayscale) | Pixels stay gray. The inks are applied by a display-time LUT. | RGB TIFF with the inks rendered |

The actual channel data (gray, CMYK planes, palette indices, bits) is
recomputed from the constrained pixels at export time. Painting colors follow
the mode: in Grayscale and Duotone the foreground and background become gray,
in Bitmap black or white, and in Indexed the nearest palette entry.

**Trade-offs.** The mode is enforced when you convert, not continuously. After
a conversion, these can bring colors outside the mode's gamut until you
convert again:

- filters
- adjustment layers
- layer styles
- blend modes, which always mix in RGB
- pasted pixels

Converting to RGB is instant, because the pixels are already RGB. Leaving
Duotone first renders the inks into the pixels. Bitmap and Duotone require
Grayscale, and Indexed requires RGB, Grayscale or Duotone. Mode conversions need an 8-bit document.

## Bit depth

Imported 16-bit and 32-bit documents keep their high-depth sources, and the
renderer composites them in float. **8 Bits/Channel** renders each pixel,
image and legacy paint layer at document size and stores the result in 8-bit
tiles. Text, shapes, fills, adjustments and groups stay editable. Untagged
32-bit documents are linear, so their values are encoded to sRGB. Values
brighter than white are clipped, and a message says so. Converting to 16 or
32 bits is refused with a message, because pixel layers store 8-bit tiles.

## Soft proofing and gamut warning

**Proof Colors.** The proof transform runs document profile, then the proof
device, then sRGB, with the proof intent, black point compensation, paper
color and black ink options. It is baked into a 33-point 3D LUT. The renderer
applies the LUT after compositing (`Renderer.setDisplayLut`, a `lutPass` into
a display texture) and presents the result. The composited document texture
is never changed, so exports, pixel readbacks and the eyedropper still see
document values. Monitor RGB shows the document values without conversion.
Standard Web RGB (sRGB) and Legacy RGB (Gamma 1.8) keep the document's numbers
but read them in that profile (a generated gamma 1.8 profile with D65 white and
the phosphors of older desktop displays), showing how an untagged copy looks in
software that ignores embedded profiles or on such a display. The
duotone preview uses the same pass. Proof settings belong to each open
document, and the tab shows `Proof: <name>` while proofing is on.

**Gamut Warning** compares each composite pixel with its printed version
(CIEDE2000 over 2, relative colorimetric, from the engine's `gamutWarning`).
The resulting mask is drawn as an overlay image in the configured color. It is
recomputed after edits. The test does not use black point compensation, so
very deep shadows darker than the press black are flagged too.

## Color picker

The square field and vertical strip can show any component: H, S, B, L, a, b,
R, G or B. Numeric fields cover HSB, RGB, Lab, CMYK (through the document's
CMYK profile or the working CMYK) and hex. Typed CMYK values are kept while you
edit them, because a CMYK to RGB to CMYK round trip regenerates black
differently.

The yellow warning triangle marks a color the CMYK profile cannot print.
Clicking it switches to the closest printable color. The cube does the same
for web-safe colors.

Clicking the image outside the dialog samples the composite. The picker opens
in its own `<dialog>`, so other dialogs can use it, for example the duotone
inks and the color table.
