# Desktop-editor parity roadmap

This file tracks the work that brings Presentation up to the feature set people
expect from a full desktop presentation editor. Each area lists what exists,
what is being added, and its status. Items are checked off as they land.

## Areas

### 1. Layouts, placeholders and master views

- [x] New presentations start on a Title Slide layout with title and subtitle
      placeholders that show prompt text until typed into. Prompts and the
      dashed outlines of empty placeholders are drawn by the editor only;
      thumbnails, slide shows, printing and saved files never contain them.
- [x] New Slide gallery with a picture of every layout of the deck's own
      masters (imported decks included); Layout gallery changes the layout of
      the selected slides, moving content into matching placeholders; Reset
      puts placeholders back to the layout's position, size and formatting and
      restores deleted ones. Duplicate Selected Slides sits in the same menu.
- [x] A full set of built-in layouts (Title Slide, Title and Content, Section
      Header, Two Content, Comparison, Title Only, Blank, Content with Caption,
      Picture with Caption, Title and Vertical Text, Vertical Title and Text),
      sized to the slide, with date, footer and slide-number placeholders.
- [x] Empty content placeholders offer quick inserts (table and picture, plus
      any insert command the Insert tab provides); the inserted object takes
      the placeholder's slot and follows it through layout changes.
- [x] Slide Master view (View tab, View menu, Ctrl/Cmd+Alt+1): contextual
      Slide Master tab, a pane with each master and its layouts, editing of
      master and layout shapes and placeholders (formatting given to master
      placeholder text becomes the style slides inherit), Insert Placeholder
      (content, text, vertical, picture, chart, table, SmartArt, media), Title
      and Footers switches, Master Layout, Hide Background Graphics, Insert
      Slide Master, Insert Layout, Delete, Rename, Duplicate, Preserve, Close
      Master View. Undo and redo work across master edits.
- [x] Handout Master and Notes Master views: page orientation, header,
      footer, date, page number (and slide image and body on notes pages)
      placeholders, slides-per-page guides on the handout page.
- [x] Reuse Slides (pick slides of another .pptx from thumbnails; keep
      their source formatting, bringing their layouts, masters and themes,
      or take this deck's matching layouts) and Slides from Outline (.txt,
      .md, .rtf: top-level lines become titles, indented lines bullets), in
      the New Slide menu and Insert > Slides from; Duplicate Slide
      (Ctrl/Cmd+Shift+D) in the Insert menu (`src/layouts/slides-from.js`).
- [x] Menu bar: Find Next / Find Previous (Ctrl/Cmd+G, +Shift+G),
      Replace, Select Data for charts, Delete Slide and section commands in
      Edit; Ribbon (Ctrl/Cmd+Alt+R, remembered) and Header and Footer in
      View; Section, Comment, WordArt, Date and Time, Slide Number and
      Symbol in Insert.
- [x] Insert Placeholder draws the placeholder on the layout (drag, or click
      for a standard size); changing the slide size stretches masters and
      layouts with it.

### 2. Themes and design

- [x] Theme gallery of 22 original themes (the four original palettes among
      them), each a real theme part (12-color scheme, heading and body fonts,
      effect and background style lists) with a master and layouts of its own
      design: backgrounds, vector artwork from theme colors, text styles and
      placeholder positions. Applying one moves the slides onto its master,
      keeping their content and re-mapping placeholders; the context menu
      applies it to the selected slides only (a second master). Thumbnails
      are drawn by the renderer from the theme itself, in the gallery, the
      Slide Master tab and the start screen's theme strip.
- [x] Variants (four color and background variants per theme), Colors (every
      scheme, plus Customize Colors with the 12 slots, a live preview and
      named schemes kept in the browser), Fonts (font pairs, plus Customize
      Fonts), Effects (six effect schemes), Background Styles (12 styles from
      the theme's background fills, for all or the selected slides, Format
      Background…, Reset Slide Background), Hide Background Graphics.
      Browse for Themes applies the master of a .thmx, .pptx or .potx file;
      Save Current Theme downloads the master as a .thmx theme file.
- [x] Format Background pane with solid (and transparency), gradient
      (presets, linear/radial/rectangular/path, angle, stops with color,
      position and transparency), picture or texture (insert, 12 textures,
      stretch with offsets or tile with offset, scale, alignment and mirror,
      transparency) and all 54 pattern fills, Hide background graphics, Apply
      to All and Reset Background; on layouts and masters too in Slide Master
      view.

### 3. Animations

- [x] Animations tab: entrance, emphasis, exit and motion path galleries,
      Effect Options, Add Animation, Animation Painter, Trigger, Start,
      Duration, Delay, Reorder.
- [x] Animation Pane with a timeline, play from, drag reordering, and a dialog
      for effect, timing and text animation settings.
- [x] Animations written to and read from the file's timing tree, previewed on
      the canvas, and played in slide shows.
- [x] Sounds on effects (Effect Options: a built-in synthesized sound or an
      audio file, embedded and written as the effect's `p:audio` /
      `p:sndTgt` node, played as the effect starts), and the Hide After
      Animation and Hide on Next Mouse Click after-effects.

### 4. Transitions

- [x] The full transition set (subtle, exciting and dynamic content groups)
      with per-transition Effect Options, Duration, Sound, Preview, On Mouse
      Click / After timing and Apply To All; morphing between slides by
      objects, words or characters (each word or letter travels to the same
      text on the next slide; the rest fades out or in).

### 5. Slide Show and Record

- [x] Set Up Slide Show dialog (presented by a speaker / browsed in a window /
      kiosk, loop, without narration or animation, media controls, slide range
      or custom show, manual or timed advance, pen and laser colors), saved
      in `presProps.xml` `p:showPr` (`src/show/setup-dialog.js`,
      `lib/pptx/src/api/fn/slide-show-setup.ts`).
- [x] Custom Shows dialog (new, edit, copy, remove, show; pick and order
      slides) saved in `p:custShowLst`; deleting a slide drops it from every
      custom show (`src/show/custom-shows.js`).
- [x] Presenter View in this window or with the audience in a second window
      (placed on another screen when the browser allows): current and next
      slide or animation click, notes with text size, timer with pause and
      restart, clock, counter, tools, all slides, zoom, black screen,
      subtitles, end show (`src/show/session.js`, `src/show/audience.js`).
- [x] During the show: right-click menu (next, previous, last viewed, see
      all slides, zoom, custom show, screen, pointer options, subtitles,
      presenter view, pause, help, end show); pen, highlighter, eraser,
      laser and arrow options with the common shortcuts; ink kept as Ink
      shapes when asked; kiosk mode; media controls on videos.
- [x] Rehearse Timings toolbar (slide time, pause, repeat, total) that keeps
      the timings as each slide's advance time; Use Timings, Play Narrations,
      Show Media Controls; Always Use Subtitles and Subtitle Settings (spoken
      language, position) with live subtitles from the browser's speech
      recognition, and a notice where there is none.
- [x] Record tab: Live Camera (a camera picture that shows the presenter's
      camera in the show), Record from Beginning / Current Slide in a
      recording studio (camera preview as a circle or rectangle, camera and
      microphone choice, pause, retake, clear), narrations stored per slide
      as media that plays by itself with the recording's timing; Clear
      Recording, Reset to Camera, and Export to Video with the narrations as
      the sound track and the recorded camera over its slides.
- [ ] Not yet: ink replayed with its timing in recordings (ink is kept as
      shapes), subtitle translation.

### 6. Insert

- [x] Icons (searchable categories; SVG pictures with a PNG stand-in;
      Graphics Format tab with fill, outline, styles, Change Graphic and
      Convert to Shape).
- [x] Video and Audio from a file, Record Audio (saved as WAV): real media
      parts with `p14:media` trim, fades and bookmarks, poster frames, canvas
      controls, a Playback tab, and playback in the slide show (start mode,
      volume, loop, rewind, hide while not playing, full screen, play across
      slides).
- [x] Screenshot (window or screen capture, and screen clipping).
- [x] Photo Album (order, layouts with titles, captions, frames, black and
      white).
- [x] Equation: TeX-style input with structure and symbol palettes, drawn by
      our own layout engine into an SVG picture that keeps its source and
      reopens for editing. (Native OMML `a14:m` output is not written yet.)
- [x] Header & Footer dialog (slides; notes and handouts).
- [x] Slide Zoom, Section Zoom and Summary Zoom (pictures with slide jumps and
      zoom settings; zoom transition and return in the slide show; Zoom tab).
- [x] Action Buttons and the Action Settings dialog (mouse click and mouse
      over: jumps, end show, sounds, highlight).
- [x] Object: files embedded as OLE Packages, shown as icons, downloaded when
      opened.
- [x] Comment: Insert > Comment (Cmd/Ctrl+Shift+M) opens the Comments pane (area 9).

### 7. Charts and SmartArt

- [x] Insert Chart with every common chart type, a data sheet editor, and
      Chart Design / Format tabs (styles, colors, elements, layouts, switch
      row/column, change type).
- [x] Data labels and trendlines on bubble and scatter charts, data tables
      on horizontal bar charts, and error-bar amounts as a fixed value,
      percentage, standard deviations, standard error or custom amounts
      (typed, or a range of the data sheet that follows its edits; written
      as `c:plus` / `c:minus`).
- [x] Insert SmartArt graphics by category with a Text Pane, SmartArt Design
      tab and Format pane section, and Convert to SmartArt for bulleted text.
- [x] SmartArt: pictures in picture layouts (buttons in empty picture
      shapes; picture fills cropped to cover), and a SmartArt Format tab for
      one shape picked on the canvas or from Select Shape: Change Shape,
      Larger, Smaller, Reset Shape, shape fill, outline and effects, and
      WordArt text styles, fill, outline and effects. Kept on presentation
      points and text runs of the data model and drawn into the saved
      drawing (`src/smartart/smartart-format.js`,
      `lib/pptx/src/api/fn/smartart/format.ts`).

### 8. Views

- [x] Outline View with editable slide titles and body text.
- [x] Slide Sorter with sections, zoom, drag reordering and transitions.
- [x] Notes Page and Reading View.
- [x] Grid and Guides dialog, smart guides, snap to grid, Zoom dialog, status
      bar view buttons.

### 9. Review

- [x] Comments pane with threaded replies, resolve, mentions, previous/next,
      saved in the file (threaded comment parts; legacy comments read too),
      draggable markers, thumbnail indicators and a status bar button.
- [x] Thesaurus, Translate, Language, Check Accessibility pane, Compare.
- [x] Spelling pane, AutoCorrect while typing, Reading Order pane, and
      Always Open Read-Only with Edit Anyway.

### 10. File, print and export

- [x] Export as PDF (slides, notes pages, handouts, outline; searchable
      text layer and bookmarks), PNG/JPEG, MP4/WebM video with transitions
      and timings, animated GIF, outline (RTF/text), template (.potx).
- [x] Print dialog with preview: full-page slides, notes pages, outline and
      handouts (1, 2, 3 with lines, 4, 6, 9 per page, across or down),
      paper and orientation, colour/grayscale/black and white, frame, scale
      to fit, hidden slides, slide range, header and footer; Save as PDF.
- [x] Properties (core and extended properties, statistics in app.xml),
      Save as Template, Compress Pictures (resolution, delete cropped
      areas, selected or all), File size summary with unused media removal.
- [x] File menu: Open recent, Close, Page setup (slide size).
- [ ] OpenDocument (.odp) export: not planned.

### 11. Format dialogs and panes

- [x] Font dialog, Paragraph dialog (indents, spacing, tabs), Bullets and
      Numbering dialog (picture and symbol bullets, start at, size, color).
      Columns dialog; bullet and numbering galleries on the ribbon.
- [x] Format Shape pane parity: gradient, picture, pattern fills; line
      compound and cap types; shadow, reflection, glow, soft edges, bevel and
      3-D rotation; text box options (autofit, margins, wrap).
      Picture corrections, color, artistic effects, crop to shape and ratio;
      text fill, outline and effects; alt text.
- [x] Replace Fonts, Paste Special, Regroup, rotation and size dialogs.
- [x] Shape, WordArt and picture style galleries; effect preset menus.
- [x] Change Shape, Edit Points and Merge Shapes; Selection Pane rename,
      reorder, show and hide all; Repeat; align to slide or to the selection.

### 12. Draw and assistant

- [x] Lasso Select, Ink to Shape, Ink to Text, Ink to Math, Add Pen, ink
      replay. Also: stroke and point erasers with sizes, a pen collection
      (pens, pencils, highlighters; colour, thickness, texture, order) kept
      on the device, Convert Ink to Shapes, a ruler stencil pens follow,
      Draw with Touch, and a slide show pen whose ink can be kept. Stroke
      timing is stored on each ink shape (`P.setShapeInkTiming`, an
      `a:extLst` extension on `p:cNvPr`) so replay survives a save.
      (`src/draw/`, `src/draw-tab.js`)
- [x] Generate a presentation from a description on the start screen, and
      New Slide from Prompt (Home tab, New Slide menu) through the
      assistant. (`src/start/deck-from-prompt.js`)
- [x] Library screen: section rail (Home, New, Recent, Open), Themes strip,
      Recent / Pinned filter, pin to top, Last opened. (`src/start/`)
- [x] Ink to Math makes a real equation object (src/insert's
      `equations.prepare/place`), re-editable by double-click; a LaTeX text
      box only where that API is missing.
- [ ] A Shared section in the rail, once Puter exposes files shared with
      the user.
