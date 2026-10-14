# View tab and document views parity

The View tab offers the document views, page movement, what to show, zoom and window tools. The
menu bar's View and Window menus carry the same commands (`extendMenu('view' | 'window')`), and the
status bar's view buttons call `setDocumentView(mode)` / `documentView()`.

Code: [views/document-views.js](../../src/views/document-views.js) (views, page movement,
gridlines, zoom, split, new window, menus), [views/outline-view.js](../../src/views/outline-view.js)
(Outline view), [views/read-mode.js](../../src/views/read-mode.js) (Read Mode),
[views/navigation-pane.js](../../src/views/navigation-pane.js), [mirror.html](../../mirror.html) +
[src/mirror.js](../../src/mirror.js) (second window); engine
[document-views.js](../../src/engine/document-views.js),
[outline-editing.js](../../src/engine/outline-editing.js),
[docx-view-settings.js](../../src/engine/docx-view-settings.js). OOXML details are in
[conformance.md](../conformance.md#document-views-2026-10-13).

## Implemented

**Views** (each remembered in the document as `w:view` when saved and restored on open)
- Print Layout: the authored pages.
- Read Mode: no ribbon; the document as screen pages in one to three columns that fit the window,
  turned with the arrow keys, Page Up/Down, Space/Shift+Space, Home/End, the side arrows, a click on
  the left or right of the page or the scroll wheel; Escape or Edit Document returns to the previous
  view. Tools: Navigation Pane and Read Aloud (the Review module's player; reading follows the spoken
  word to the right screen). View: Column Width (Narrow, Default, Wide), Page Color (None, Sepia,
  Inverse), Text Spacing (lines, paragraphs and letters), Line Focus (one, three or five lines; Up/Down
  move it). Typing and clicks never change the document here.
- Web Layout: text reflows to the window width (re-laid out on resize and zoom), no page boundaries,
  headers or footers, the page colour across the full width; fully editable.
- Outline: an indented outline with outline symbols (plus: heading with text under it; minus:
  heading without; dot: body text), double-click or Alt+Shift+Plus/Minus to expand and collapse,
  a click on a symbol selects the heading with its text. Text is edited in place (typing, Enter
  splits, Backspace/Delete at the ends merge, paste as plain text, Ctrl/Cmd+Z/Y undo and redo in the
  document). The Outlining tab: Promote to Heading 1, Promote, Outline Level, Demote, Demote to Body
  Text, Move Up, Move Down, Expand, Collapse, Show Level (1–9, All Levels), Show Text Formatting,
  Show First Line Only, Close Outline View. Tab/Shift+Tab and Alt+Shift+arrows work as in desktop
  word processors. Every change is one undo step and saves as styles or outline levels.
- Draft: continuous text, floating drawings hidden, page and section breaks as labelled dotted rules,
  and an optional Style Area (0.5, 1 or 1.5 inch) listing each paragraph's style.
- Ctrl+Alt+P (Cmd+Option+P) Print Layout and Ctrl+Alt+N (Cmd+Option+N) Draft.

**Immersive**: Focus hides the chrome and goes full screen where the browser allows it; leaving full
screen leaves Focus.

**Page Movement**: Vertical or Side to Side (pages in a row at whole-page zoom, the wheel scrolls
across, the caret's page is kept in view) with a Thumbnails strip.

**Show**: Ruler, Gridlines (spacing ⅛, ¼, ½ inch, 0.5 or 1 cm, drawn on screen only), Navigation
Pane. The Navigation pane's headings can be dragged to move their sections (or moved with
Alt+Shift+Up/Down) and have a context menu: Promote, Demote, New Heading Before/After, New
Subheading, Select Heading and Content, Delete, Expand All, Collapse All. Pages shows thumbnails of
the screen pages; Results lists search hits in context.

**Zoom**: a Zoom dialog with 200%, 100%, 75%, Page width, Text width, Whole page, a many-pages grid
(up to 4 × 3) and a percentage, previewed live (Cancel restores); 100%, One Page, Multiple Pages,
Page Width; Ctrl/Cmd + wheel and trackpad or Safari pinch zoom around the pointer.

**Window**: New Window opens a second browser window with a live, read-only copy of the document that
follows edits (BroadcastChannel; the original window keeps the only save handler). Split shows a
second, independently scrolling pane below the first with a draggable (or arrow-key) divider; a
click in it places the caret there.

**Properties**: shown on the View tab when the File backstage provides `documentProperties()`.

## Approximated

- Web Layout and Draft are laid out as tall strips trimmed to their text; a strip boundary can
  suppress space before the first paragraph of the next strip, and footnotes sit at the bottom of
  their strip rather than with the text.
- Draft hides floating drawings, but text still wraps around the area they reserve.
- Read Mode's text spacing and columns are approximations of a reflowing reader: tables and pictures
  wider than a column are clipped to it; Read Mode is not stored in the file.
- Outline view shows tables as one row, and paragraphs holding pictures, fields, content controls,
  notes or tracked changes as read-only text (edit those in the other views). Ribbon formatting
  commands act on the paragraph with the caret.
- New Window is a read-only copy rather than a second editing window.

## Gaps

- Syllables in Read Mode; Read Mode page-turn animation; comments in Read Mode.
- Master documents and subdocuments (Outline's Show Document, Create, Insert, Unlink, Lock).
- Arrange All, View Side by Side, Synchronous Scrolling, Switch Windows (not meaningful on the web).
- Macros; the Draft font option; Draft's wrap-to-window setting.
