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
- [ ] Draw a placeholder's rectangle on the canvas with Insert Placeholder
      (it is placed in the middle of the layout for now).

### 2. Themes and design

- [ ] Theme gallery of original themes, each a real theme part (color scheme,
      font scheme, effect and background styles) applied through the master.
- [ ] Variants, Colors, Fonts and Background Styles galleries; Customize
      Colors and Customize Fonts dialogs; Save Current Theme.
- [ ] Format Background pane with solid, gradient, picture/texture and
      pattern fills, Hide background graphics, Apply to All, Reset.

### 3. Animations

- [ ] Animations tab: entrance, emphasis, exit and motion path galleries,
      Effect Options, Add Animation, Animation Painter, Trigger, Start,
      Duration, Delay, Reorder.
- [ ] Animation Pane with a timeline, play from, drag reordering, and a dialog
      for effect, timing and text animation settings.
- [ ] Animations written to and read from the file's timing tree, previewed on
      the canvas, and played in slide shows.

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

- [ ] Insert Chart with every common chart type, a data sheet editor, and
      Chart Design / Format tabs (styles, colors, elements, layouts, switch
      row/column, change type).
- [ ] Insert SmartArt graphics by category with a Text Pane, SmartArt Design
      and Format tabs, and Convert to SmartArt for bulleted text.

### 8. Views

- [ ] Outline View with editable slide titles and body text.
- [ ] Slide Sorter with sections, zoom, drag reordering and transitions.
- [ ] Notes Page and Reading View.
- [ ] Grid and Guides dialog, smart guides, snap to grid, Zoom dialog, status
      bar view buttons.

### 9. Review

- [ ] Comments pane with threaded replies, resolve, mentions, previous/next,
      saved in the file.
- [ ] Thesaurus, Translate, Language, Check Accessibility pane, Compare.

### 10. File, print and export

- [ ] Export as PDF, PNG/JPEG, video, animated GIF, outline (RTF/text).
- [ ] Print dialog with full-page slides, notes pages, outline and handouts
      (1, 2, 3, 4, 6, 9 per page), frame, scale to fit.
- [ ] Properties, Save as Template, Compress Pictures, Reduce File Size.

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
