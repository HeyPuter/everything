# Pictures, shapes and Arrange parity

What the Picture Format and Shape Format tabs, the Layout tab's Arrange group and direct manipulation
on the page offer compared with desktop word processors, what is approximated, and what is missing.
File-format details are in [conformance.md](../conformance.md) (sections "Picture Format, Shape
Format and Arrange" and "Picture and shape effects, preset picture geometry and hidden drawings").

Every command rewrites the drawing's DrawingML (`src/engine/drawing-format.js`): the drawing is written
as saving would write it, the edit changes that XML, and the result is read back through the same strict
reader used for opening files. What is painted is what is saved, untouched XML stays as authored, and
each command is one undo step. A combination the reader cannot keep is refused with a message rather
than saved lossily.

## Implemented

| Area | Commands |
| --- | --- |
| Picture Format → Adjust | Remove Background (original segmentation: background colour model from outside a movable subject box, edge flood with keep/remove brush marks, island cleanup and a feathered edge; the processed picture is a new PNG and the original is kept); Corrections (Sharpen/Soften presets, a 5 × 5 Brightness/Contrast grid written as `a:lum`, options in the Format pane); Color (Saturation and Color Tone presets, Recolor: grayscale, sepia, washout, black and white 25/50/75 %, dark and light variants of each theme colour as `a:duotone`, More Variations, Set Transparent Color as `a:clrChange`); Artistic Effects (eleven original filters); Transparency (presets and a slider, `a:alphaModFix`); Compress Pictures (resample for 220/150/96 ppi at the shown size, delete cropped areas, this picture or all; released media is dropped on save when nothing uses it); Change Picture (from a file; keeps the frame size and formatting, crops the new picture to fill it); Reset Picture and Reset Picture & Size |
| Picture Format → Picture Styles | Gallery of twenty original styles (frames, shadows, rounded and oval shapes, soft edges, glow, reflections, bevel, double frame, snipped corners, hexagon, tilted frame), live thumbnails of the selected picture; Picture Border (theme and standard colours, custom colour, weight, dashes, More Lines); Picture Effects (shadow, reflection, glow, soft edges, bevel and 3-D rotation presets with options) |
| Accessibility | Alt Text pane on both tabs: description, optional title, Mark as decorative |
| Arrange (Picture Format, Shape Format and Layout tabs) | Position (In Line with Text and nine square-wrapped page positions), Wrap Text (in line, square, tight, through, top and bottom, behind, in front; Move with Text / Fix Position on Page; More Layout Options), Bring Forward / to Front / in Front of Text, Send Backward / to Back / Behind Text, Selection Pane, Align (left, center, right, top, middle, bottom, distribute horizontally and vertically; to page, margin or selected objects; view gridlines; grid settings), Group / Ungroup / Regroup, Rotate (90° left/right, flip vertical/horizontal, More Rotation Options) |
| Size | Crop (on the page) with Crop to Shape (preset shapes), Aspect Ratio (nine ratios), Fill and Fit; Height and Width (pictures keep their proportions); Size and Position dialog |
| Layout dialog | Position (alignment or absolute offsets with their reference frames, move with text, lock anchor, allow overlap, layout in table cell), Text Wrapping (style, sides, distances), Size (height, width, rotation, scale, lock aspect ratio, original size and reset) |
| Shape Format | Insert Shapes (shapes gallery, Edit Shape → Change Shape with every preset, Text Box); Shape Styles gallery (six treatments × seven theme colours, theme-aware); Shape Fill (colours, picture, six gradients, sixteen patterns); Shape Outline (colour, weight, dashes, arrows, More Lines); Shape Effects (shadow, reflection, glow, soft edges); WordArt Styles (quick styles, text fill, text outline, text shadow on the shape's text); Text → Align Text (top, middle, bottom) |
| Format pane | Fill & Line (no/solid/gradient/pattern fill with transparency, gradient type, angle and stops; line colour, width, compound, dash, cap, join, arrows), Effects (shadow colour, transparency, blur, distance, angle; reflection; glow; soft edges; bevel and 3-D rotation for pictures), Layout & Properties (text box alignment, autofit, insets, wrap text in shape; size and rotation; alt text), Picture (sharpness, brightness, contrast, saturation, temperature, recolor, transparency, artistic effect, crop) |
| Selection Pane | Every drawing of the story front to back, visibility toggles (`docPr hidden`), Show All / Hide All, rename (double-click or F2), multi-select with Shift/Ctrl, restack by dragging or Alt+Up/Down and the Bring Forward / Send Backward buttons |
| On the page | Selection handles on all sides and corners (Shift keeps proportions), rotation handle with 15° snapping, smart alignment guides to the page, margins and other objects while dragging, arrow-key nudging, Shift/Ctrl+click multi-selection with group moves, crop mode with crop handles, layout options button beside the selected object, anchor indicator |
| Menus | Format → Picture…/Shape…, Arrange, Group, Wrap Text, Selection Pane…; View → Selection Pane; context menu: Change Picture, Crop, Edit Shape, Group, Bring to Front, Send to Back, Wrap Text, Edit Alt Text…, Size and Position…, Format Picture…/Format Shape… |

## Approximated

- Tight and Through wrapping keep their wrap polygon in the file, but text wraps around the
  object's rectangle (as Square does).
- Position presets write column- and paragraph-relative offsets that put the object at the chosen
  place on the current page; the object then moves with its paragraph rather than staying at the
  page position when text before it changes.
- Sharpen/Soften, Saturation, Color Tone, Artistic Effects and Remove Background change pixels: the
  picture shows a processed copy and keeps the original with the list of edits (the picture's original
  layer), so any edit can be changed later and Reset Picture restores the original. Other applications
  show the processed copy. Background-removal marks are stored as line segments; brush width and
  sensitivity are not stored and use their defaults when the picture is edited again.
- Artistic effects, colour tone and saturation are this app's own filters; their look differs from
  other applications'.
- WordArt Styles change the run properties of the shape's text: fill, outline and shadow. Glow,
  reflection and 3-D text are not available.
- Gridlines are drawn over the pages for alignment; snapping to the grid uses the same spacing.
- Recolor previews and gallery thumbnails are approximations drawn in the browser.

## Gaps

- Picture Layout (convert pictures to a captioned diagram), Edit Points for freeform shapes, Edit Wrap
  Points, shape adjustment (yellow) handles, linked text boxes (Create Link) and Text Direction for
  shape text (vertical text in shapes is not supported by the engine).
- Bevel and 3-D rotation are limited to what the engine renders on pictures (circle and angle bevels,
  perspective left/right); shapes have no bevel or 3-D options.
- Relative (percentage) positions and sizes cannot be set from the Layout dialog; existing ones are
  kept as authored.
- Square, tight and through wrapping keep column/paragraph coordinates; aligned or page-relative
  wrapped objects are not offered.
- Grouping is limited to floating pictures, shapes and groups on one page; charts, diagrams and objects
  with links cannot be grouped.
- Change Picture from the cloud, stock or online pictures; Save as Picture; Set as Default Layout.
