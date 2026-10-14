# Desktop-editor parity roadmap

This file tracks the work that brings Presentation up to the feature set people
expect from a full desktop presentation editor. Each area lists what exists,
what is being added, and its status. Items are checked off as they land.

## Areas

### 1. Layouts, placeholders and master views

- [ ] New presentations start on a Title Slide layout with title and subtitle
      placeholders that show prompt text until typed into.
- [ ] New Slide gallery with a picture of every layout of the slide's master;
      Layout gallery changes the layout of the selected slides; Reset puts
      placeholders back to the layout's position, size and formatting.
- [ ] A full set of built-in layouts (Title Slide, Title and Content, Section
      Header, Two Content, Comparison, Title Only, Blank, Content with Caption,
      Picture with Caption, Title and Vertical Text, Vertical Title and Text).
- [ ] Slide Master view: edit the master and each layout, insert placeholders,
      toggle title and footers, rename, duplicate, delete and preserve layouts,
      insert a new master or layout, close master view.
- [ ] Handout Master and Notes Master views.

### 2. Themes and design

- [ ] Theme gallery of original themes, each a real theme part (color scheme,
      font scheme, effect and background styles) applied through the master.
- [ ] Variants, Colors, Fonts and Background Styles galleries; Customize
      Colors and Customize Fonts dialogs; Save Current Theme.
- [ ] Format Background pane with solid, gradient, picture/texture and
      pattern fills, Hide background graphics, Apply to All, Reset.

### 3. Animations

- [x] Animations tab: entrance, emphasis, exit and motion path galleries,
      Effect Options, Add Animation, Animation Painter, Trigger, Start,
      Duration, Delay, Reorder.
- [x] Animation Pane with a timeline, play from, drag reordering, and a dialog
      for effect, timing and text animation settings.
- [x] Animations written to and read from the file's timing tree, previewed on
      the canvas, and played in slide shows.
- [ ] Adding sounds to effects (sounds already in a file are kept).

### 4. Transitions

- [ ] The full transition set (subtle, exciting and dynamic content groups)
      with per-transition Effect Options, Duration, Sound, Preview, On Mouse
      Click / After timing and Apply To All; morphing between slides.

### 5. Slide Show and Record

- [ ] Set Up Slide Show dialog (presented by a speaker / browsed / kiosk, loop,
      without narration or animation, slide range, pen and laser colors).
- [ ] Custom Shows, Rehearse Timings, Use Timings, Play Narrations, Show Media
      Controls, Presenter View, live subtitles.
- [ ] Record tab: record the show with narration, camera and ink per slide,
      clear recordings, export as video.

### 6. Insert

- [ ] Icons, Video, Audio (from file and recorded), Screenshot, Photo Album,
      Equation, Header & Footer dialog, Slide Zoom / Section Zoom / Summary
      Zoom, Action Buttons, Object, Comment.

### 7. Charts and SmartArt

- [x] Insert Chart with every common chart type, a data sheet editor, and
      Chart Design / Format tabs (styles, colors, elements, layouts, switch
      row/column, change type).
- [x] Insert SmartArt graphics by category with a Text Pane, SmartArt Design
      tab and Format pane section, and Convert to SmartArt for bulleted text.
- [ ] SmartArt: pictures in picture layouts, per-shape formatting (a SmartArt
      Format tab).

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

- [ ] Font dialog, Paragraph dialog (indents, spacing, tabs), Bullets and
      Numbering dialog (picture and symbol bullets, start at, size, color).
- [ ] Format Shape pane parity: gradient, picture, pattern fills; line
      compound and cap types; shadow, reflection, glow, soft edges, bevel and
      3-D rotation; text box options (autofit, margins, wrap).
- [ ] Replace Fonts, Paste Special, Regroup, rotation and size dialogs.

### 12. Draw and assistant

- [ ] Lasso Select, Ink to Shape, Ink to Text, Ink to Math, Add Pen, ink
      replay.
- [ ] Generate a presentation from a description on the start screen.
