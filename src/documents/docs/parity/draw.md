# Draw parity

The Draw tab sits after Insert. It writes and sketches on the page with pens, pencils and
highlighters, erases, selects ink with a lasso, draws against a ruler, converts ink to shapes and
(with Puter's AI) to equations, replays ink, hides it and inserts drawing canvases. The Edit menu has
Toggle Drawing (Cmd+Ctrl+Z on macOS, Ctrl+Alt+Z elsewhere), the Insert menu Drawing Canvas, the View
menu Hide Ink; right-clicking ink offers Convert to Shape, Bring to Front, Send to Back and Delete Ink.
Review's Hide Ink calls `toggleInk()` / `inkHidden()`.

Code: [draw-tab.js](../../src/views/draw-tab.js) (tab, tools, commands, menus),
[draw-surface.js](../../src/views/draw-surface.js) (pointer input, live overlay, ruler),
[draw-commit.js](../../src/views/draw-commit.js) (document transactions, anchoring),
[draw-pens.js](../../src/views/draw-pens.js) (pen gallery), [draw-math.js](../../src/views/draw-math.js)
(Ink to Math); engine [ink-geometry.js](../../src/engine/ink-geometry.js) (smoothing, outlines,
erasing, lasso, ruler), [ink-recognizer.js](../../src/engine/ink-recognizer.js),
[ink-shapes.js](../../src/engine/ink-shapes.js), [docx-ink.js](../../src/engine/docx-ink.js). OOXML
details: [conformance.md](../conformance.md#draw-tab-ink-drawing-canvases-and-ink-to-shape-2026-10-13).

## Implemented

- **Tools**: Select (back to typing), Lasso Select, Eraser (stroke or point eraser, small/medium/large,
  Erase All Ink on This Page / in Document), and a pen gallery of pens, a pencil and a highlighter.
  Clicking the active pen opens its settings: thickness (with previews), a colour palette (a
  highlighter palette for highlighters), any colour, Remove Pen. Add Pen adds a pen, pencil or
  highlighter (up to 12). The gallery, active pen, eraser and touch choices are kept in this
  browser's storage. A short reminder names the tool; Esc returns to typing.
- **Input**: Pointer Events for mouse, pen and touch, coalesced samples, pen pressure when reported.
  Draw with Touch (on by default) lets a finger draw instead of scroll; while a pen is down or was
  just lifted, touches are ignored, and a pen landing cancels a touch stroke (palm rejection).
- **Ruler**: an on-page straightedge with inch graduations at the document's zoom. Drag to move;
  mouse wheel (Shift for 1°) or two fingers to turn; arrow keys move it and Alt+arrows turn it when it
  has focus. A stroke started just outside an edge is laid along that edge.
- **Rendering**: samples are steadied by a distance-adaptive filter, joined by a cubic spline and
  drawn as a pressure-width ribbon with round ends — live on an overlay at display rate, then
  committed with the identical outline. Highlighter ink multiplies with the page while drawing and
  is saved behind the text.
- **Storage**: each stroke is one undo step; ending the session gathers its strokes into one group
  per page and layer without another undo step. Ink is ordinary DrawingML (filled custom-geometry
  outlines in a group) with an extension recording each stroke, so it reopens as editable ink here
  and displays in other word processors.
- **Lasso**: draw a loop; strokes mostly inside are selected. Drag to move, Delete to remove,
  Ink to Shape to convert, Ink to Math to start the math pad from them.
- **Ink to Shape**: a toggle that turns each new pen stroke into a line, arrow, rectangle, oval or
  triangle when it is recognised (other strokes stay ink), and a command on a lasso selection or a
  right-clicked ink drawing. Rotated rectangles and ovals keep their angle (snapped under 10°).
- **Ink to Math**: a writing pad (pre-filled from selected ink) whose picture is read by Puter's AI
  into a linear-format equation, editable with a live preview, then inserted through the Insert tab's
  equation dialog. Hidden when the AI or the equation command is unavailable.
- **Ink Replay** redraws all ink stroke by stroke (Stop or Esc ends it). **Hide Ink** hides ink on
  screen (it is still saved). **Drawing Canvas** inserts an inline framed group; ink started in it
  stays inside it.

## Approximated

- Pencil texture is a DrawingML 75% pattern fill, not a grain bitmap; on screen the pattern is
  aligned to the page.
- Highlighter ink in the saved file is a 50% translucent fill behind the text, not a true multiply.
- The drawing canvas is a group with a frame rectangle rather than a canvas object; it does not grow
  as you draw near its edge.
- Ink to Shape recognises single strokes and a line capped by a separate V (an arrow); polygons with
  more corners, stars and connectors are left as ink.

## Gaps

- No InkML import/export; ink from other processors' ink parts is not editable as ink.
- No ink in headers, footers, footnotes or table cells; pages on which no paragraph starts cannot
  take new ink.
- No pen effects (galaxy, rainbow), action pen, ink editor gestures or ink-to-text.
- Each ink edit (stroke during a session, eraser sweep, move) keeps the previous drawing for undo;
  very long editing sessions on large drawings count against the session's image budget.
- Lasso selection is per page; moving ink between pages is not supported.
