import { el, isComposing } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { openSymbolPicker } from '../ui/symbols.js';
import { styleRun } from '../engine/styles.js';
import { canvasFontFamily } from '../engine/font-families.js';
import { displayedFont } from '../engine/font-availability.js';
import { MAX_FONT_SIZE } from '../engine/font-size.js';
import { stepFontSize } from '../lib/fontsize.js';

/** Twips per inch and per centimetre: page settings are stored in twips. */
const IN = 1440, CM = 1440 / 2.54;
/** The margin presets a desktop word processor offers, in inches: top, bottom, left, right. */
export const MARGIN_PRESETS = [
  ['Normal', 1, 1, 1, 1],
  ['Narrow', 0.5, 0.5, 0.5, 0.5],
  ['Moderate', 1, 1, 0.75, 0.75],
  ['Wide', 1, 1, 2, 2],
];
/** Paper sizes in twips, portrait. */
export const PAPER_PRESETS = [
  ['Letter', '8.5″ × 11″', 12240, 15840],
  ['Legal', '8.5″ × 14″', 12240, 20160],
  ['Executive', '7.25″ × 10.5″', 10440, 15120],
  ['Tabloid', '11″ × 17″', 15840, 24480],
  ['A3', '29.7 cm × 42 cm', 16838, 23811],
  ['A4', '21 cm × 29.7 cm', 11906, 16838],
  ['A5', '14.8 cm × 21 cm', 8391, 11906],
  ['B5 (JIS)', '18.2 cm × 25.7 cm', 10319, 14572],
];
export const PAGE_COLORS = [
  ['White', 'FFFFFF'], ['Ivory', 'FFFDF2'], ['Light gray', 'F2F2F2'], ['Light blue', 'DEEAF6'], ['Light green', 'E2EFD9'],
  ['Light yellow', 'FFF2CC'], ['Light orange', 'FBE4D5'], ['Light red', 'F8D7D7'], ['Light purple', 'E7DCF0'], ['Light teal', 'D9F0EF'],
];

/** Date formats for Insert → Date & Time, as a word processor lists them. */
export function dateFormats(now = new Date(), locale = undefined) {
  const f = options => new Intl.DateTimeFormat(locale, options).format(now);
  const pad = n => String(n).padStart(2, '0');
  const list = [
    f({ dateStyle: 'short' }),
    f({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    f({ year: 'numeric', month: 'long', day: 'numeric' }),
    f({ dateStyle: 'medium' }),
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    f({ day: 'numeric', month: 'long', year: 'numeric' }),
    f({ month: 'long', year: 'numeric' }),
    f({ dateStyle: 'short', timeStyle: 'short' }),
    f({ timeStyle: 'short' }),
    f({ timeStyle: 'medium' }),
  ];
  return [...new Set(list)];
}

/** Document statistics for a text: words, characters with and without spaces, paragraphs. */
export function documentStatistics(text) {
  const plain = String(text).replace(/[￼]/g, '');
  const words = plain.trim() ? plain.trim().split(/\s+/u).filter(Boolean).length : 0;
  const characters = [...plain.replace(/[\n\f\v]/g, '')].length;
  const noSpaces = [...plain.replace(/\s/gu, '')].length;
  const paragraphs = plain.split('\n').filter(p => p.replace(/[\f\v\t ]/g, '').length).length;
  return { words, characters, noSpaces, paragraphs };
}

/** Change case: sentence, lower, upper, capitalized words or toggled. Returns the new text of the same length per code unit where possible. */
export function changeTextCase(text, mode) {
  if (mode === 'upper') return text.toLocaleUpperCase();
  if (mode === 'lower') return text.toLocaleLowerCase();
  if (mode === 'toggle') return [...text].map(ch => ch === ch.toLocaleUpperCase() ? ch.toLocaleLowerCase() : ch.toLocaleUpperCase()).join('');
  if (mode === 'title') return text.toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, gap, ch) => gap + ch.toLocaleUpperCase());
  if (mode === 'sentence') {
    let start = true;
    return [...text.toLocaleLowerCase()].map(ch => {
      if (/\p{L}/u.test(ch)) { const out = start ? ch.toLocaleUpperCase() : ch; start = false; return out; }
      if (/[.!?\n\f]/.test(ch)) start = true;
      return ch;
    }).join('');
  }
  return text;
}

/**
 * The ribbon's commands that the editor's own controls do not already cover. Each acts on the
 * current editor through the same transactions as the toolbar, so undo and saving work unchanged.
 */
export function createWordCommands({ editor, pkg, error, zoomControl, fitWidth, openFind, root, focus }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const run = action => { const engine = ready(); if (!engine) return false; engine.finishComposition(); const ok = engine.execute(() => action(engine)); engine.focus(); return ok; };
  const setPage = patch => { const engine = ready(); if (!engine) return; engine.finishComposition(); try { engine.setPageSettings(patch); } catch (e) { error(e); } engine.focus(); };
  const page = () => editor()?.model.pageSettings;
  const near = (a, b) => Math.abs(a - b) < 15;
  let focusExit = null;

  const commands = {
    growFont(direction, step = null) {
      const engine = ready(); if (!engine) return;
      const size = engine.model.runCommandFormatting.fontSize;
      if (size === null || size === undefined) return;
      const next = step ? size + direction * step : stepFontSize(size, direction);
      engine.setFontSize(Math.max(1, Math.min(MAX_FONT_SIZE, next)));
    },
    // Replace goes to its own field once there is something to find; with Find empty it starts there.
    openReplace() { openFind(); queueMicrotask(() => { if (document.querySelector('.canvas-find input[aria-label="Find text"]')?.value) document.querySelector('.canvas-find input[aria-label="Replace with"]')?.focus(); }); },
    insertBlankPage() { run(engine => { engine.model.insertPageBreak(); engine.model.insertPageBreak(); }); },
    insertLineBreak() { run(engine => engine.model.replace('\v')); },
    insertDateTime() {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      const list = el('div.ed-choice-list', { role: 'listbox', 'aria-label': 'Available formats' });
      let modal;
      const choose = text => { modal.close(); run(e => e.model.replace(text)); };
      for (const [i, text] of dateFormats().entries()) {
        const option = el('button.ed-choice', { type: 'button', role: 'option', 'aria-selected': String(i === 0), onclick: () => choose(text),
          onkeydown: e => {
            if (isComposing(e)) return;
            const items = [...list.children], at = items.indexOf(option);
            const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : null;
            if (next !== null && items[next]) { e.preventDefault(); items[next].focus(); }
          } }, text);
        list.append(option);
      }
      modal = openModal({ title: 'Date and Time', content: el('div.ed-dialog-body', {}, el('p.field-hint', {}, 'Choose a format. The date is inserted as text.'), list), onClose: () => queueMicrotask(() => editor()?.focus()) });
      list.firstChild?.focus();
    },
    insertSymbol() {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      openSymbolPicker({ onPick: ch => run(e => e.model.replace(ch)) });
    },
    canEditHeader(kind) { return !!headerArea(kind); },
    editHeader(kind) {
      const engine = ready(), area = headerArea(kind);
      if (!engine || !area) return;
      try { engine.editStory(area.path, area.page); engine.focus(); } catch (e) { error(e); }
    },
    marginItems() {
      const p = page();
      return MARGIN_PRESETS.map(([label, top, bottom, left, right]) => ({
        label, hint: `Top ${top}″ · Bottom ${bottom}″ · Left ${left}″ · Right ${right}″`, radio: true,
        checked: !!p && near(p.top, top * IN) && near(p.bottom, bottom * IN) && near(p.left, left * IN) && near(p.right, right * IN),
        onSelect: () => setPage({ top: top * IN, bottom: bottom * IN, left: Math.round(left * IN), right: Math.round(right * IN) }),
      }));
    },
    orientationItems() {
      const p = page();
      return [['Portrait', 'portrait'], ['Landscape', 'landscape']].map(([label, value]) => ({
        label, radio: true, checked: p?.orientation === value,
        onSelect: () => {
          const current = page(); if (!current || current.orientation === value) return;
          // Turning the page swaps its sides and rotates the margins with it.
          setPage({ orientation: value, width: current.height, height: current.width,
            ...(value === 'landscape' ? { top: current.left, bottom: current.right, left: current.bottom, right: current.top }
              : { top: current.right, bottom: current.left, left: current.top, right: current.bottom }) });
        },
      }));
    },
    sizeItems() {
      const p = page();
      return PAPER_PRESETS.map(([label, hint, width, height]) => {
        const [w, h] = p?.orientation === 'landscape' ? [height, width] : [width, height];
        return { label, hint, radio: true, checked: !!p && near(p.width, w) && near(p.height, h), onSelect: () => setPage({ width: w, height: h }) };
      });
    },
    columnItems() {
      const p = page();
      const count = p?.columns?.count || 1, equal = p?.columns?.equalWidth !== false;
      const text = p ? p.width - p.left - p.right - (p.gutterAtTop ? 0 : p.gutter) : 0;
      // Left and Right presets: two columns, the narrower about a third of the width, half an inch apart.
      const uneven = narrowFirst => {
        const narrow = Math.round((text - 720) / 3), wide = text - 720 - narrow;
        return { count: 2, space: 720, equalWidth: false, separator: false, entries: narrowFirst ? [{ width: narrow, space: 720 }, { width: wide, space: 0 }] : [{ width: wide, space: 720 }, { width: narrow, space: 0 }] };
      };
      const first = p?.columns?.entries?.[0]?.width, second = p?.columns?.entries?.[1]?.width;
      return [
        ...[['One', 1], ['Two', 2], ['Three', 3]].map(([label, n]) => ({
          label, icon: 'columns', radio: true, checked: count === n && (n === 1 || equal),
          onSelect: () => setPage({ columns: n === 1 ? null : { count: n, space: 720, equalWidth: true, separator: false } }),
        })),
        { label: 'Left', radio: true, checked: count === 2 && !equal && first < second, onSelect: () => setPage({ columns: uneven(true) }) },
        { label: 'Right', radio: true, checked: count === 2 && !equal && first > second, onSelect: () => setPage({ columns: uneven(false) }) },
        { separator: true },
        { label: 'Line Between', checked: !!p?.columns?.separator, disabled: count < 2, onSelect: () => setPage({ columns: { ...page().columns, separator: !page().columns.separator } }) },
      ];
    },
    pageBorderItems() {
      const p = page(), current = p?.pageBorders;
      const box = (style, size) => ({ offsetFrom: 'page', display: 'allPages', zOrder: 'front',
        borders: Object.fromEntries(['top', 'left', 'bottom', 'right'].map(side => [side, { style, size, space: 24, color: 'auto' }])) });
      // The stored borders carry normalized fields (frame, shadow, colour) the presets leave out: compare what a preset sets.
      const same = value => current?.offsetFrom === value.offsetFrom && Object.entries(value.borders).every(([side, b]) => {
        const at = current.borders?.[side];
        return !!at && at.style === b.style && at.size === b.size && at.space === b.space;
      }) && Object.keys(current.borders || {}).length === Object.keys(value.borders).length;
      const choices = [['Box, ½ pt line', 'single', 4], ['Box, 1½ pt line', 'single', 12], ['Box, 3 pt line', 'single', 24], ['Box, double line', 'double', 6], ['Box, dotted', 'dotted', 6], ['Box, dashed', 'dashed', 6]];
      return [{ label: 'No Border', radio: true, checked: !current, onSelect: () => setPage({ pageBorders: null }) }, { separator: true },
        ...choices.map(([label, style, size]) => { const value = box(style, size); return { label, radio: true, checked: !!current && same(value), onSelect: () => setPage({ pageBorders: value }) }; })];
    },
    pageColorItems() {
      const p = page();
      return [{ label: 'No Color', radio: true, checked: !p || p.background === 'auto', swatch: 'none', onSelect: () => setPage({ background: 'auto' }) }, { separator: true },
        ...PAGE_COLORS.map(([label, hex]) => ({ label, radio: true, checked: p?.background === hex, swatch: `#${hex}`, onSelect: () => setPage({ background: hex }) }))];
    },
    setIndent(key, inches) {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      if (engine.setParagraphGeometry({ [key]: Math.round(inches * IN) }) === false) error(new Error('That indent does not fit the page.'));
      engine.focus();
    },
    indentValue(key) {
      const value = editor()?.model.paragraphFormatting?.[key];
      return value === null || value === undefined ? null : Math.round(value / IN * 100) / 100;
    },
    canArrange() { return !pkg()?.readOnly && !!editor()?.model.selectedImage?.anchor; },
    arrange(direction) { run(engine => engine.model.arrangeImage(direction)); },
    wrapItems() {
      const image = editor()?.model.selectedImage;
      return [
        { label: 'In Front of Text', icon: 'inFront', radio: true, checked: !!image?.anchor && !image.anchor.behind, disabled: !commands.canArrange(), onSelect: () => commands.arrange('inFront') },
        { label: 'Behind Text', icon: 'behindText', radio: true, checked: !!image?.anchor?.behind, disabled: !commands.canArrange(), onSelect: () => commands.arrange('behind') },
        { label: 'Bring to Front', icon: 'bringForward', disabled: !commands.canArrange(), onSelect: () => commands.arrange('front') },
        { label: 'Send to Back', icon: 'sendBackward', disabled: !commands.canArrange(), onSelect: () => commands.arrange('back') },
      ];
    },
    deleteSelection() { run(engine => engine.model.replace('')); },
    canUpdateFields() { const engine = editor(); return !!engine && !pkg()?.readOnly && engine.session.path === null && !!engine.model.hasBodyFields; },
    updateFields() { const engine = ready(); if (engine) { engine.updatePageReferences(); engine.focus(); } },
    wordCount() {
      const engine = editor(); if (!engine) return;
      engine.finishComposition();
      const [a, b] = engine.model.range, selected = a !== b;
      const stats = documentStatistics(selected ? engine.model.text.slice(a, b) : engine.model.text);
      const row = (label, value) => el('tr', {}, el('th', { scope: 'row' }, label), el('td', {}, value.toLocaleString()));
      openModal({ title: 'Word Count', onClose: () => queueMicrotask(() => editor()?.focus()), content: el('div.ed-dialog-body', {},
        el('p.field-hint', {}, selected ? 'Statistics for the selected text:' : 'Statistics:'),
        el('table.ed-stats', {}, el('tbody', {},
          ...(selected ? [] : [row('Pages', engine.layout.pageCount)]),
          row('Words', stats.words), row('Characters (no spaces)', stats.noSpaces), row('Characters (with spaces)', stats.characters), row('Paragraphs', stats.paragraphs))),
        el('div.modal-actions', {}, el('button.btn.btn-primary', { type: 'button', onclick: e => e.target.closest('.modal-panel')?.querySelector('.modal-head .icon-btn')?.click() }, 'Close'))) });
    },
    setZoom(value) { const engine = editor(); if (!engine) return; zoomControl.set(value); engine.focus(); },
    zoomTo(kind) {
      const engine = editor(); if (!engine) return;
      if (kind === 'width') { zoomControl.set('fit'); fitWidth(); }
      else {
        const host = engine.host, widest = Math.max(...engine.layout.pages.map(p => p.width)), tallest = Math.max(...engine.layout.pages.map(p => p.height));
        const scale = Math.min((host.clientWidth - 48) / widest, (host.clientHeight - 48) / tallest);
        zoomControl.set(Math.max(0.1, Math.min(2, Math.floor(scale * 100) / 100)));
      }
      engine.focus();
    },
    zoomDialog() {
      const engine = editor(); if (!engine) return;
      const percent = el('input.input', { type: 'number', min: 10, max: 200, step: 1, value: Math.round(engine.zoom * 100), 'aria-label': 'Percent' });
      let modal;
      const apply = value => { modal.close(); if (value === 'fit' || value === 'page') commands.zoomTo(value === 'fit' ? 'width' : 'page'); else commands.setZoom(value); };
      const preset = (label, value) => el('button.btn.btn-outline', { type: 'button', onclick: () => apply(value) }, label);
      modal = openModal({ title: 'Zoom', onClose: () => queueMicrotask(() => editor()?.focus()), content: el('form.ed-dialog-body', { onsubmit: e => {
        e.preventDefault(); if (!percent.checkValidity()) { percent.reportValidity(); return; } apply(Number(percent.value) / 100);
      } },
      el('div.ed-zoom-presets', {}, preset('200%', 2), preset('100%', 1), preset('75%', 0.75), preset('50%', 0.5), preset('Page width', 'fit'), preset('Whole page', 'page')),
      el('label.field', {}, el('span.field-label', {}, 'Percent'), percent),
      el('div.modal-actions', {}, el('button.btn.btn-primary', { type: 'submit' }, 'OK'))) });
    },
    focusMode() {
      if (focusExit) { focusExit(); return; }
      const exit = el('button.btn.ed-focus-exit', { type: 'button', onclick: () => focusExit?.() }, 'Exit Focus');
      const onKey = e => { if (e.key === 'Escape' && !isComposing(e) && !document.querySelector('.modal-root, .menu')) { e.preventDefault(); focusExit?.(); } };
      root().classList.add('ed-focus');
      root().append(exit);
      window.addEventListener('keydown', onKey, true);
      // Focus fills the screen where the browser allows it; leaving full screen (Esc) leaves Focus too.
      let fullScreen = false;
      const onFullScreen = () => { if (fullScreen && !document.fullscreenElement) focusExit?.(); };
      document.addEventListener('fullscreenchange', onFullScreen);
      if (document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).then(() => { fullScreen = true; }, () => {});
      focusExit = () => {
        root().classList.remove('ed-focus'); exit.remove(); window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('fullscreenchange', onFullScreen);
        if (fullScreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        fullScreen = false; focusExit = null; fitWidth(); focus();
      };
      fitWidth(); focus();
    },
    stylePreview(id) {
      const engine = editor(); if (!engine) return null;
      try {
        const run = styleRun(engine.model.styles, id);
        return { bold: !!run.bold, italic: !!run.italic, size: run.fontSize, color: run.color && run.color !== 'auto' ? `#${run.color}` : null,
          fontFamily: canvasFontFamily({ fontFamily: displayedFont({ fontFamily: run.fontAscii }, engine.model.styles.fontAlternatives) }) };
      } catch { return null; }
    },
    drawingTextItems() { return []; },
  };

  function headerArea(kind) {
    const engine = editor();
    if (!engine || pkg()?.readOnly) return null;
    const areas = (engine.storyLayout?.positions || []).filter(item => engine.pageStories.stories[item.path]?.editable && engine.pageStories.stories[item.path].kind === kind);
    if (!areas.length) return null;
    const pageIndex = engine.caretPageIndex ?? 0;
    return areas.find(item => item.page === pageIndex) || areas[0];
  }

  return commands;
}
