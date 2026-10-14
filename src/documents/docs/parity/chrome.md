# Application chrome — parity notes

Scope: the menu bar, the File view, the title bar, the status bar, ribbon display and KeyTips, the
document context menu shell, keyboard shortcuts and Customize Keyboard, and the Edit menu's own
commands. OOXML behaviour (document properties, `w:lang`) is recorded in `docs/conformance.md`
("Document properties, proofing language and the view-only lock").

## Implemented

**Menu bar** (`src/views/classic-menus.js`, `src/views/title-bar.js`, `src/ui/menubar.js`)
- File, Edit, View, Insert, Format, Tools, Table, Window and Help in the title bar row, wired to the
  editor's existing commands. Entries whose command no module provides are left out; entries that do
  not apply to the selection are disabled. Shortcuts show in the items and follow Customize Keyboard.
- Full menubar keyboard model: one tab stop, Left/Right/Home/End, Down/Enter to open, Left/Right
  between open menus, Escape back to the name; Ctrl+F2 (Mac) or Alt+F10 focuses it.
- `extendMenu(menuId, kit)` contract chained in `editor.js`. A module entry with the same name as a
  built-in one takes its place (the module owns that command); its other entries follow after a
  separator, each name once.
- Narrow windows fold the menus into one Menus button with each menu as a submenu.

**File view** (`src/views/backstage.js`)
- New (blank, built-in templates, your templates), Open (this device, all documents, recent),
  Info (properties stored in `docProps/core.xml`, file facts, statistics, View Only, version history
  with save-a-version and restore for documents saved to Puter), Save (save, download a copy, save as
  template, rename, Save As to a new Puter file), Print (page previews, copies, all/current/custom
  page range, page setup), Share (publish/update/unpublish a web page on Puter hosting, copy its
  link, send .docx or PDF), Export (.docx, PDF, web page, Markdown, plain text), Close, Preferences.
- Full-window, focus-trapped, Escape or Back returns to the document (or to the File button when it
  was opened from the keyboard).

**Title bar**
- AutoSave switch (cloud documents; remembered on the device; turning it back on saves pending
  edits), quick access (All Documents, Save, Undo with a history drop-down, Redo, Print) with a
  Customize Quick Access menu (New, Open, Find, Spelling, Save as PDF, formatting marks, New Comment,
  Track Changes, Word Count, Read Aloud, Repeat; remembered).
- Undo history: each step is named after the ribbon or menu command that made it ("Bold",
  "Paste Formatting"), otherwise "Typing" or "Formatting"; choosing an entry undoes back to it.
- Document name with a details popover (rename, location, status, version history, properties).
- Command search (Cmd+Option+K / Alt+Q): every labelled ribbon button, the choices of ribbon
  drop-downs (Orientation › Landscape, Margins › Narrow…) and every menu item, ranked by label then
  path, with shortcuts; recent commands when empty; falls back to finding the text.
- Editing / Reviewing / Viewing: Reviewing turns Track Changes on through the review module;
  Viewing locks every edit path in the engine (`setViewOnly`) and disables the ribbon, without
  touching the package or its layout.
- Comments (opens the Reviewing Pane with comments shown) and Share (cloud only).

**Status bar** (`src/views/status-bar.js`)
- Page X of Y (Go To), word count with selection ("2 of 3 words", Word Count), spelling state,
  language of the selection (picker writes `w:lang` and optionally `w:noProof`), Track Changes
  indicator (hidden by default), editing area, Text mode, Focus, view buttons (Print Layout, plus
  any mode a module provides through `setDocumentView`/`documentViewModes`), zoom slider/percent.
- Right-click to choose the items shown (remembered); View > Status Bar hides it.

**Ribbon display and KeyTips** (`src/ui/ribbon-modes.js`)
- Always show / Show tabs only / Auto-hide (remembered); double-click a tab, the chevron at the right
  end of the tab row, or
  Cmd+Option+R / Ctrl+F1 toggles. In a collapsed ribbon a tab click shows the commands over the
  document until a command runs, Escape, or a click elsewhere.
- KeyTips: press and release Alt (Option) or F10 (not Mac): badges for File (F), the tabs (H, N, G,
  P, S, R, W, contextual J…), quick access (1–9), search (Q) and the menu bar (0); a tab then labels
  its commands with prefix-free codes. Escape steps back.

**Document context menu** (`src/views/document-context-menu.js`)
- Detects image, shape, link, field, list, table and text; spelling suggestions, clipboard, Font…,
  Paragraph…, list numbering, copy/paste formatting, link edit/open/copy/remove, Update Field,
  picture and shape commands, table rows/columns, comments and changes, then each module's
  `contextMenuItems(context, kit)` entries (chained in `editor.js`) for every detected context.

**Keyboard** (`src/views/keymap.js`, `src/views/customize-keyboard.js`, `src/ui/shortcuts.js`)
- New chords: Copy/Paste Formatting (Mod+Shift+C, then Mod+Shift+V until text is copied again),
  Paste and Match Formatting (Mod+Option/Alt+Shift+V), Paste Special (Cmd+Ctrl+V / Ctrl+Alt+V, when
  the format area provides it), Repeat (F4; Mod+Y when there is nothing to redo), Find Next/Previous
  (Shift+F4, Mod+Shift+F4), Go To (also Cmd+Option+G on a Mac), Paragraph (Cmd+Option+M, Mac), Styles
  (Mod+Option/Alt+Shift+S, when provided), Open (Mod+O), Save As (Mod+Shift+S), Preferences (Mod+,),
  command search, ribbon collapse, Focus (Cmd+Ctrl+Shift+F, Mac), menu bar focus.
- Existing chords kept: headings (Mod+Alt+1…6), Normal (Mod+Alt+0, Ctrl+Shift+N), alignment, indents
  and hanging indent (Ctrl+M/T), line spacing 1/1.5/2 (Mod+1/5/2), space before (Mod+0), double and
  word underline, small caps, all caps, sub/superscript, font size steps, Clear formatting.
- Customize Keyboard: any ribbon or menu command can get a chord (moved from its previous owner),
  bindings can be removed or reset, conflicts with built-in chords are explained; stored in this
  browser and listed in the Keyboard Shortcuts sheet.

**Edit menu**: Repeat, Clear → Clear Formatting / Contents, Links… (lists every body hyperlink with
its address; select, edit, remove, remove all), Copy/Paste Formatting, Find Next/Previous.

**Preferences** (`src/views/preferences.js`): appearance and dark page, units, opening zoom,
AutoCorrect (quotes/symbols, sentence capitals, links), spelling as you type and recheck, language,
AutoSave, ruler, formatting marks, status bar, ribbon display, Customize Keyboard, shortcuts, KeyTips.
Changes apply at once.

## Approximations

- Hidden text (Ctrl+Shift+H): the engine reads `w:vanish` but cannot set it yet (`setRunFormat`
  rejects it), so the chord is not bound.
- Repeat re-runs the last ribbon or menu command that changed the document (toggles toggle again);
  typed text and dialog settings (Font…, Paragraph…) are not repeated.
- Undo step names come from the command that ran just before the change; edits made through
  dialogs are named by the button that opened them only when that button ran the change itself.
- The language picker marks text; spelling still checks English only.
- Find Next/Previous use the Navigation pane's query (or the selection); on a Mac Cmd+G remains
  Go To (as before in this app) rather than Find Next.
- Web page, Markdown and plain-text exports cover the body only.
- Version history and Share need a document saved to Puter; on this device they are left out.
- Viewing is a session state, not saved as document protection.

## Gaps

- Read Mode, Web Layout, Outline and Draft views: the status bar and View menu show them only when a
  module provides `setDocumentView`/`documentViewModes` (the view-modes area).
- Format menu dialogs owned by the format area (Bullets and Numbering…, Borders and Shading…, Tabs…,
  Styles pane, Reveal Formatting, Paste Special) appear only when that area provides them; until then
  the menu uses the existing commands (Borders…, Indents and tabs).
- Insert/References items not yet exposed as commands (Caption…, Cross-reference…) are omitted.
- No dictation, Writing Tools, macros, add-ins, compare/combine, protect document, or window
  arrangement (Split, Arrange All).
- `docProps/app.xml` statistics are not recomputed on save; `cp:revision` is not advanced.
- KeyTips do not yet descend into drop-down menus or folded group drop-downs (a code opens them; the
  menu then takes arrow keys).
