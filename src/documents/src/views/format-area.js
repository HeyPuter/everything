import { el, isComposing, MOD_KEY } from '../ui/dom.js';
import { commandIconEl } from '../ui/ribbon.js';
import { applyMultilevelList } from '../engine/list-library.js';
import { openMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { paragraphFormat } from '../engine/model.js';
import { changeCase, captureFormat, applyFormat } from '../engine/home-editing.js';
import { prepareCanvasFont, documentFontAvailable } from '../engine/font-availability.js';
import { checkedParagraphBorder } from '../engine/paragraph-borders.js';
import { defineBullet, defineNumberFormat, adjustListIndents, defineMultilevelList, continueNumbering, previousList, currentListValue, selectedLevelDefinition, selectedListLevel } from '../engine/list-definitions.js';
import { styleUsage, styleRanges, deleteStyle, styleDeletionBlocker, createStyleFromSelection } from '../engine/style-management.js';
import { similarFormatCondition, similarFormattingRanges } from '../engine/format-inspection.js';
import { directParagraph, directRun } from '../engine/home-editing.js';
import { PASTE_MODES, pastePayload, availablePasteModes } from '../engine/paste-modes.js';
import { fragmentHtml } from '../engine/clipboard-fragment.js';
import { levelFor } from '../engine/numbering.js';
import { styleDisplayName } from '../lib/style-names.js';
import { openFontDialog } from './font-dialog.js';
import { openParagraphDialog } from './paragraph-dialog.js';
import { openTabsDialog } from './tabs-dialog.js';
import { openBordersAndShading } from './borders-shading.js';
import { openDefineBullet, openDefineNumberFormat, openSetNumberingValue, openAdjustListIndents, openDefineMultilevelList } from './list-dialogs.js';
import { openTextEffects } from './text-effects-dialog.js';
import { openChangeCase, openNewStyle, openApplyStyles, openStyleDialog, openBulletsAndNumbering, openPasteSpecial, describeStyle, CASE_MODES } from './format-misc-dialogs.js';
import { openStyleEditor } from './style-editor.js';
import { createStylesPane } from './styles-pane.js';
import { createDictation } from './dictate.js';
import { fontCondition } from './find-replace.js';

const MAC = MOD_KEY === 'Cmd';
const chord = mac => MAC ? mac : mac.replace('Cmd+Ctrl', 'Ctrl+Alt').replace('Cmd+Option', 'Ctrl+Alt').replace('Cmd', 'Ctrl');
const NULL_RUN = { fontAscii: null, fontHAnsi: null, bold: null, italic: null, fontSize: null, color: null, underlineStyle: null, underlineColor: null, strikethrough: null, capitalization: null, verticalAlign: null, vanish: null, textScale: null, characterSpacing: null, baselineShift: null, kerning: null, ligatures: null };
const BORDER_ITEMS = [['Bottom Border', ['bottom'], 'borderBottom'], ['Top Border', ['top'], 'borderTop'], ['Left Border', ['left'], 'borderLeft'], ['Right Border', ['right'], 'borderRight'],
  ['All Borders', ['top', 'bottom', 'left', 'right', 'between'], 'borderAll'], ['Outside Borders', ['top', 'bottom', 'left', 'right'], 'borderOuter'], ['Inside Borders', ['between'], 'borderInside']];

/**
 * The Format area: the Font, Paragraph, Tabs, Borders and Shading, Bullets and Numbering, Change Case,
 * Text Effects and Style dialogs, the Styles pane (with Style Inspector and Reveal Formatting), Apply
 * Styles, the Select menu, paste options and Paste Special, advanced Find formatting, Format Painter
 * shortcuts and Dictate. Every change goes through the engine's transactions (one undo step each).
 *
 * It contributes commands to the editor's command object, ribbon groups (extendTab), menu-bar items
 * (extendMenu) and document context-menu items (contextMenuItems).
 */
export function createFormatArea({ editor, pkg, error, refresh: refreshChrome = () => {}, host, unit = () => 'in', focus = () => editor()?.focus(), openFind, finder = () => null, pageSetup = () => {}, clipboard = {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const readOnly = () => !!pkg()?.readOnly || !editor();
  const later = () => queueMicrotask(() => editor()?.focus());
  /** Run a model change as one undo step; throw its error so a dialog can show it. */
  const transact = action => {
    const engine = ready(); if (!engine) throw new Error('This document is read only.');
    engine.finishComposition();
    let failure = null;
    const ok = engine.execute(() => action(engine.model, engine), e => { failure = e; }, undefined, true);
    if (!ok) throw failure || new Error('This change could not be applied.');
    return true;
  };
  /** Run a change from a menu: errors become a toast. */
  const run = action => { try { transact(action); } catch (e) { error(e); } editor()?.focus(); };
  let modal = null;
  const track = opened => { modal = opened; return opened; };

  /* ---- Font and text effects ---- */
  function fontDialog({ title = 'Font', seed = null, capture = null } = {}) {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const [start, end] = engine.model.range;
    const format = seed ? { ...NULL_RUN, ...seed } : engine.model.runCommandFormatting;
    return track(openFontDialog({ title, format, sample: engine.model.text.slice(start, end), onClose: capture ? null : later,
      ligatures: !capture && !!engine.model.styles?.openTypeFeatures,
      textEffects: capture || readOnly() ? null : () => textEffectsDialog(),
      setDefault: capture || readOnly() ? null : async (patch, fail) => {
        const id = engine.model.styles.defaultParagraph;
        if (!id) { fail(new Error('This document has no default paragraph style to change.')); return false; }
        if (!await confirmDialog({ title: 'Set as default', message: `Make this the default font for this document? Text in the ${styleDisplayName(engine.model.styles.definitions[id]?.name || 'Normal')} style and styles based on it will change.`, confirmLabel: 'Set As Default', danger: false })) return false;
        const run = { ...patch };
        if (run.capitalization === 'normal') run.capitalization = null;
        if (run.strikethrough === 'none') run.strikethrough = null;
        try { return transact(m => m.editParagraphStyle(id, { run })); } catch (e) { fail(e); return false; }
      },
      apply: async (patch, fail) => {
        if (capture) { capture(patch); return true; }
        if (patch.fontAscii) {
          await prepareCanvasFont(patch.fontAscii);
          if (documentFontAvailable(patch.fontAscii, engine.model.styles.fontAlternatives) !== true) { fail(new Error(`${patch.fontAscii} could not be loaded on this device. Choose another font.`)); return false; }
        }
        if (editor() !== engine) return false;
        return engine.execute(() => engine.model.setRunFormat(patch), fail, undefined, true);
      } }));
  }
  function textEffectsDialog() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    return track(openTextEffects({ format: engine.model.runFormatting, onClose: later, apply: patch => transact(m => m.setRunFormat(patch)) }));
  }

  /* ---- Paragraph and tabs ---- */
  function paragraphDialog(initialTab = 'indents') {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const format = engine.model.paragraphFormatting;
    return track(openParagraphDialog({ format, unit: unit(), initialTab, canSetOutline: engine.model.canSetOutlineLevel, onClose: later,
      apply: patch => transact(m => m.setParagraphFormat(patch)),
      openTabs: async patch => {
        if (Object.keys(patch).length) transact(m => m.setParagraphFormat(patch));
        queueMicrotask(() => tabsDialog());
        return true;
      },
      setDefault: async patch => {
        const id = engine.model.styles.defaultParagraph;
        if (!id) throw new Error('This document has no default paragraph style to change.');
        if (!Object.keys(patch).length) return true;
        if (!await confirmDialog({ title: 'Set as default', message: `Make these paragraph settings the default for this document? Paragraphs in the ${styleDisplayName(engine.model.styles.definitions[id]?.name || 'Normal')} style will change.`, confirmLabel: 'Set As Default', danger: false })) return false;
        return transact(m => m.editParagraphStyle(id, { paragraph: patch }));
      } }));
  }
  function tabsDialog() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    return track(openTabsDialog({ tabs: engine.model.paragraphFormatting.tabs, defaultTabStop: engine.model.pageSettings.defaultTabStop, unit: unit(), onClose: later,
      apply: (tabs, interval) => transact(m => m.setParagraphGeometry(tabs === undefined ? {} : { tabs }, interval)) }));
  }

  /* ---- Borders and shading ---- */
  function bordersDialog(initialTab = 'borders') {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const model = engine.model, formats = model.selectedParagraphs.map(p => paragraphFormat(p, model.numbering).paragraphBorders);
    const same = formats.every(f => JSON.stringify(f) === JSON.stringify(formats[0]));
    return track(openBordersAndShading({ initialTab, onClose: later, values: {
      paragraphBorders: same ? formats[0] : null, paragraphShading: model.paragraphFormatting.paragraphShading, runShading: model.runFormatting.shading,
      pageBorders: model.pageSettings.pageBorders, singleSection: !model.paragraphs.some(p => p.sectionEnd) },
    apply: patch => transact(m => {
      if (patch.paragraphBorders) m.setParagraphFormat({ paragraphBorders: patch.paragraphBorders });
      if (patch.paragraphShading !== undefined) m.setParagraphFormat({ paragraphShading: patch.paragraphShading });
      if (patch.runShading !== undefined) m.setRunFormat({ shading: patch.runShading });
      if ('pageBorders' in patch) m.setPageSettings({ pageBorders: patch.pageBorders });
    }) }));
  }
  let lastBorder = ['bottom'];
  const borderSides = model => {
    const f = model.paragraphFormatting.paragraphBorders;
    return f ? Object.entries(f).filter(([, b]) => b && !['none', 'nil'].includes(b.style) && b.size !== 0).map(([side]) => side) : [];
  };
  function setBorders(sides, { toggle = true } = {}) {
    lastBorder = sides;
    run(m => {
      const on = borderSides(m), all = sides.every(s => on.includes(s)) && toggle;
      const line = checkedParagraphBorder({ style: 'single', size: 4, space: 1, color: 'auto' }), off = checkedParagraphBorder({ style: 'none' });
      m.setParagraphFormat({ paragraphBorders: Object.fromEntries(sides.map(s => [s, all ? off : { ...line, space: ['left', 'right'].includes(s) ? 4 : s === 'between' ? 0 : 1 }])) });
    });
  }
  function paragraphBorderItems() {
    const engine = editor(), on = engine ? borderSides(engine.model) : [], disabled = !ready();
    return [...BORDER_ITEMS.map(([label, sides, icon]) => ({ label, icon, disabled, checked: sides.every(s => on.includes(s)), onSelect: () => setBorders(sides) })),
      { label: 'No Border', icon: 'borderNone', disabled, onSelect: () => run(m => m.setParagraphFormat({ paragraphBorders: Object.fromEntries(['top', 'bottom', 'left', 'right', 'between'].map(s => [s, checkedParagraphBorder({ style: 'none' })])) })) },
      { separator: true },
      { label: 'Borders and Shading…', icon: 'borders', disabled: !engine, onSelect: () => bordersDialog() }];
  }

  /* ---- Bullets and numbering ---- */
  const listCommand = (dialog, kind) => {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const info = selectedLevelDefinition(engine.model);
    const level = info && (kind === 'bullet' ? info.kind === 'bullet' : info.kind === 'number') ? info.level : null;
    return track(dialog({ level, levelIndex: info?.list.level ?? 0, unit: unit(), onClose: later,
      apply: options => transact(m => kind === 'bullet' ? defineBullet(m, options) : defineNumberFormat(m, options)) }));
  };
  function setNumberingValue() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    if (engine.model.listFormatting !== 'number') { toast('Place the cursor in a numbered list to set its value.', { icon: 'info' }); return; }
    return track(openSetNumberingValue({ current: currentListValue(engine.model) ?? 1, canContinue: !!previousList(engine.model), onClose: later,
      apply: ({ mode, value }) => transact(m => {
        if (mode === 'continue') { continueNumbering(m); if (value !== null) m.restartNumbering(value); }
        else m.restartNumbering(value);
      }) }));
  }
  function adjustIndents() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const info = selectedLevelDefinition(engine.model);
    if (!info) { toast('Place the cursor in a list to adjust its indents.', { icon: 'info' }); return; }
    return track(openAdjustListIndents({ level: info.level, unit: unit(), onClose: later, apply: options => transact(m => adjustListIndents(m, options)) }));
  }
  function defineMultilevel() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const list = selectedListLevel(engine.model);
    const levels = Array.from({ length: 9 }, (_, i) => { try { return list ? levelFor(engine.model.numbering, { numId: list.numId, level: i }) : null; } catch { return null; } });
    return track(openDefineMultilevelList({ levels, unit: unit(), onClose: later, apply: definitions => transact(m => defineMultilevelList(m, definitions)) }));
  }
  function bulletsAndNumbering(initialTab) {
    const engine = editor(); if (!engine) return;
    const w = commandsRef();
    const kind = engine.model.listFormatting;
    return track(openBulletsAndNumbering({ initialTab: initialTab || (kind === 'number' ? 'number' : 'bullet'), onClose: later,
      current: { bullet: w.listLibraryIndex?.('bullet') ?? -1, number: w.listLibraryIndex?.('number') ?? -1 },
      apply: (k, index) => k === 'multilevel' ? run(m => applyMultilevelList(m, index)) : w.applyListLibrary?.(k, index),
      none: k => w.removeList?.(k === 'multilevel' ? engine.model.listFormatting : k),
      define: k => k === 'bullet' ? listCommand(openDefineBullet, 'bullet') : k === 'number' ? listCommand(openDefineNumberFormat, 'number') : defineMultilevel(),
      setValue: setNumberingValue, adjust: adjustIndents }));
  }

  /* ---- Styles ---- */
  const pane = createStylesPane({ editor, readOnly, actions: {
    apply: id => applyStyle(id), modify: id => modifyStyle(id), create: () => newStyle(), remove: id => removeStyle(id), selectAll: id => selectInstances(id),
    updateToMatch: id => run(m => {
      const p = m.selectedParagraphs[0], run_ = m.formatAt(m.range[0], 'forward');
      const paragraph = directParagraph(m, p), text = directRun(m, run_, p);
      for (const key of ['tabs', 'paragraphBorders']) delete paragraph[key];
      for (const key of ['cs', 'rtl', 'boldCs', 'italicCs', 'fontSizeCs', 'highlight', 'textFill', 'textOutline', 'ligatures']) delete text[key];
      m.editParagraphStyle(id, { ...(Object.keys(paragraph).length ? { paragraph } : {}), ...(Object.keys(text).length ? { run: text } : {}) });
    }),
    clearFormatting: () => run(m => { m.clearDirectTextFormatting(); m.clearDirectParagraphFormatting(); if (m.styles.defaultParagraph) m.setParagraphStyle(m.styles.defaultParagraph); if (m.characterStyle) m.setCharacterStyle(''); }),
    clearParagraph: () => run(m => m.clearDirectParagraphFormatting()),
    clearText: () => run(m => m.clearDirectTextFormatting()),
    resetParagraphStyle: () => run(m => m.setParagraphStyle(m.styles.defaultParagraph || '')),
    clearCharacterStyle: () => run(m => m.setCharacterStyle('')),
    openTarget: target => openTarget(target), focusEditor: focus } });
  function applyStyle(id) {
    const engine = ready(); if (!engine) return false;
    const type = engine.model.styles.definitions[id]?.type;
    if (type === 'character') engine.setCharacterStyle(id); else engine.setParagraphStyle(id);
    return true;
  }
  function modifyStyle(id) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const style = engine.model.styles.definitions[id];
    if (!style) return;
    const character = style.type === 'character';
    track(openStyleEditor(style, character ? engine.model.characterStyles : engine.model.paragraphStyles, patch => {
      const ok = character ? engine.editCharacterStyle(id, patch) : engine.editParagraphStyle(id, patch); if (ok) later(); return ok;
    }, character ? engine.model.styles.defaults.run : undefined));
  }
  function newStyle() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    track(openNewStyle({ paragraphStyles: engine.model.paragraphStyles, characterStyles: engine.model.characterStyles, basedOn: engine.model.paragraphStyle || '', characterBase: engine.model.characterStyle || '', onClose: later,
      apply: ({ name, type, basedOn, next }) => {
        const taken = Object.values(engine.model.styles.definitions).some(s => String(s.name).toLowerCase() === name.toLowerCase());
        if (taken) throw new Error(`A style named “${name}” already exists. Choose another name.`);
        return transact(m => { if (!createStyleFromSelection(m, name, { type, basedOn, next })) throw new Error('The style could not be created.'); });
      } }));
  }
  async function removeStyle(id) {
    const engine = ready(); if (!engine) return false;
    const blocker = styleDeletionBlocker(engine.model, id);
    if (blocker) { toast(blocker, { icon: 'info' }); return false; }
    const name = styleDisplayName(engine.model.styles.definitions[id].name), count = styleUsage(engine.model).get(id) || 0;
    if (!await confirmDialog({ title: 'Delete style', message: `Delete the style “${name}”?${count ? ` ${count} ${count === 1 ? 'use returns' : 'uses return'} to the default style; direct formatting is kept.` : ''}`, confirmLabel: 'Delete' })) return false;
    try { transact(m => deleteStyle(m, id)); pane.refresh(); return true; } catch (e) { error(e); return false; }
  }
  /** Select the ranges of one condition: contiguous ones as one selection, otherwise the first with all highlighted. */
  let highlighted = null;
  function selectRanges(ranges, what, onFind) {
    const engine = editor(); if (!engine || !ranges.length) { toast(`No ${what} found.`, { icon: 'info' }); return; }
    engine.finishComposition();
    const text = engine.model.text;
    const contiguous = ranges.every((r, i) => !i || /^\n?$/.test(text.slice(ranges[i - 1].end, r.start)));
    if (contiguous) { engine.selectMatch({ start: ranges[0].start, end: ranges.at(-1).end }); engine.setFindHighlights([]); highlighted = null; return; }
    engine.selectMatch({ start: ranges[0].start, end: ranges[0].end });
    engine.setFindHighlights(ranges.map(r => ({ start: r.start, end: r.end })));
    highlighted = { start: ranges[0].start, end: ranges[0].end };
    toast(`${ranges.length} ${what} highlighted. The first is selected; use Find formatting to change them all.`, { icon: 'info', action: onFind ? { label: 'Find', onClick: onFind } : null });
  }
  function selectInstances(id) {
    const engine = editor(); if (!engine) return;
    const style = engine.model.styles.definitions[id];
    selectRanges(styleRanges(engine.model, id), 'instances', () => advancedFind(style?.type === 'character' ? { characterStyle: id } : { paragraphStyle: id }));
  }
  function selectSimilar() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const condition = similarFormatCondition(engine.model);
    selectRanges(similarFormattingRanges(engine.model), 'passages with similar formatting', () => advancedFind(condition));
  }
  function selectObjects() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const objects = []; let at = 0;
    for (const p of engine.model.paragraphs) { for (const r of p.runs) { if (r.image) objects.push(at); at += r.text.length; } at++; }
    if (!objects.length) { toast('There are no pictures, shapes or text boxes in this part of the document.', { icon: 'info' }); return; }
    const [start, end] = engine.model.range, current = end === start + 1 ? objects.indexOf(start) : -1;
    const next = current >= 0 ? objects[(current + 1) % objects.length] : objects.find(p => p >= start) ?? objects[0];
    engine.selectMatch({ start: next, end: next + 1 });
  }
  function applyStylesBox() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    track(openApplyStyles({ styles: [...engine.model.paragraphStyles, ...engine.model.characterStyles], current: engine.model.characterStyle || engine.model.paragraphStyle || '', onClose: later,
      apply: id => { if (!applyStyle(id)) throw new Error('This document is read only.'); return true; },
      modify: id => modifyStyle(id), pane: () => stylesPane('styles'),
      create: name => {
        if (readOnly()) throw new Error('This document is read only.');
        return transact(m => { if (!createStyleFromSelection(m, name)) throw new Error('The style could not be created.'); });
      } }));
  }
  function styleDialog() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    track(openStyleDialog({ current: engine.model.paragraphStyle || '', onClose: later,
      styles: () => { const m = editor()?.model; return m ? Object.values(m.styles.definitions).filter(s => ['paragraph', 'character'].includes(s.type)) : []; },
      describe: id => describeStyle(editor().model.styles, id), usage: () => styleUsage(editor().model),
      actions: { readOnly, apply: id => { if (!applyStyle(id)) throw new Error('This document is read only.'); return true; }, modify: modifyStyle, create: newStyle, remove: removeStyle } }));
  }
  function stylesPane(view = 'styles') {
    if (pane.visible && pane.view === view) { pane.close(); refreshChrome(); focus(); return; }
    pane.open(view); refreshChrome();
  }
  function openTarget(target) {
    if (target === 'font') fontDialog();
    else if (target === 'paragraph') paragraphDialog();
    else if (target === 'tabs') tabsDialog();
    else if (target === 'borders') bordersDialog();
    else if (target === 'numbering') bulletsAndNumbering();
    else if (target === 'page') pageSetup();
    else if (target === 'effects') textEffectsDialog();
    else styleDialog();
  }

  /* ---- Find formatting ---- */
  function advancedFind(format = null) {
    openFind?.({ advanced: true });
    if (format) finder()?.setFindFormat(format);
  }
  const findApi = {
    chooseFont: (seed, done) => fontDialog({ title: 'Find Font', seed: Object.fromEntries(Object.entries(seed || {}).filter(([k]) => k in NULL_RUN)), capture: patch => done(fontCondition(patch)) }),
    chooseParagraph: (seed, done) => {
      const nulls = Object.fromEntries(['alignment', 'outlineLevel', 'indentLeft', 'indentRight', 'firstLine', 'spaceBefore', 'spaceAfter', 'lineRule', 'lineSpacing', 'contextualSpacing', 'mirrorIndents', 'widowControl', 'keepNext', 'keepLines', 'pageBreakBefore', 'suppressLineNumbers', 'suppressAutoHyphens'].map(k => [k, null]));
      track(openParagraphDialog({ format: { ...nulls, ...seed }, unit: unit(), apply: patch => { done(patch); return true; } }));
    },
    styles: () => { const m = editor()?.model; return m ? [...m.paragraphStyles, ...m.characterStyles].filter(s => !s.error).map(s => ({ id: s.id, name: styleDisplayName(s.name), type: m.styles.definitions[s.id]?.type })) : []; },
  };

  /* ---- Paste ---- */
  let lastPaste = null, chip = null, original = null;
  async function readClipboard() {
    let text = '', html = '', picture = null;
    if (navigator.clipboard?.read) {
      for (const item of await navigator.clipboard.read()) {
        if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        const type = item.types.find(t => /^image\/(png|jpeg|tiff)$/i.test(t));
        if (!picture && type) picture = new File([await item.getType(type)], `pasted.${type.split('/')[1]}`, { type });
      }
    } else text = await navigator.clipboard.readText();
    return { text, html, picture };
  }
  function pasteWith(engine, mode, data) {
    const payload = pastePayload(mode, data, fragmentHtml);
    (original || engine.pasteData.bind(engine))(payload.text, payload.html);
  }
  async function pasteAs(mode) {
    const engine = ready(); if (!engine) return;
    const selection = [...engine.model.range], revision = engine.session.revision;
    try {
      const data = await readClipboard();
      if (engine !== editor() || revision !== engine.session.revision || JSON.stringify(selection) !== JSON.stringify(engine.model.range)) return;
      if (data.picture && !data.text) { await engine.insertImageFile(data.picture); return; }
      const before = engine.session.revision;
      pasteWith(engine, mode, data);
      if (engine.session.revision !== before) remember(engine, data, mode);
      engine.focus();
    } catch (e) { error(e); }
  }
  function remember(engine, data, mode) {
    lastPaste = { engine, data, mode, revision: engine.session.revision };
    showChip(engine);
  }
  function hideChip() { chip?.remove(); chip = null; }
  function showChip(engine) {
    hideChip();
    const rect = engine.input.getBoundingClientRect(), root = host();
    if (!root || !rect.width && !rect.height) return;
    const bounds = root.getBoundingClientRect();
    const button = el('button.paste-options-chip', { type: 'button', 'aria-label': 'Paste Options', title: `Paste Options (${MOD_KEY})`, 'aria-haspopup': 'menu', onclick: () => openMenu({ anchor: button, label: 'Paste Options', onClose: () => editor()?.focus(), items: pasteModeItems() }) },
      commandIconEl('paste', 16), el('span.ribbon-caret', { 'aria-hidden': 'true' }));
    button.addEventListener('mousedown', e => e.preventDefault());
    button.style.left = `${Math.max(4, Math.min(bounds.width - 48, rect.left - bounds.left + root.scrollLeft + 4))}px`;
    button.style.top = `${rect.bottom - bounds.top + root.scrollTop + 4}px`;
    root.append(button);
    chip = button;
  }
  function pasteModeItems() {
    const current = lastPaste, engine = editor();
    const modes = current && engine ? availablePasteModes(engine.model, current.data) : [];
    return Object.entries(PASTE_MODES).map(([mode, label]) => ({ label, radio: true, checked: current?.mode === mode, disabled: !modes.includes(mode), onSelect: () => switchPaste(mode) }));
  }
  function switchPaste(mode) {
    const current = lastPaste, engine = ready();
    if (!current || !engine || current.engine !== engine || current.revision !== engine.session.revision || current.mode === mode) return;
    engine.undo();
    pasteWith(engine, mode, current.data);
    lastPaste = { ...current, mode, revision: engine.session.revision };
    showChip(engine);
    engine.focus();
  }
  async function pasteSpecial() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    let data;
    try { data = await readClipboard(); } catch (e) { error(new Error('The clipboard could not be read. Allow clipboard access, or paste with the keyboard.')); return; }
    const formatted = availablePasteModes(engine.model, data).includes('keep');
    const choices = [
      ...(formatted ? [{ id: 'keep', label: 'HTML format', hint: 'Text with the source’s fonts, styles and lists' }, { id: 'merge', label: 'Formatted text (merged)', hint: 'Bold, italic and underline only, in this document’s formatting' }] : []),
      ...(data.text ? [{ id: 'text', label: 'Unformatted text', hint: 'Plain text in the current formatting' }] : []),
      ...(data.picture ? [{ id: 'picture', label: 'Picture', hint: `${data.picture.type.split('/')[1].toUpperCase()} image` }] : []),
    ];
    if (!choices.length) { toast('The clipboard is empty.', { icon: 'info' }); return; }
    track(openPasteSpecial({ source: data.text, choices, onClose: later, apply: async choice => {
      if (choice === 'picture') { await engine.insertImageFile(data.picture); return true; }
      const before = engine.session.revision;
      pasteWith(engine, choice, data);
      if (engine.session.revision !== before) remember(engine, data, choice);
      return true;
    } }));
  }
  function pasteItems() {
    const state = clipboard.state?.() || {};
    return [
      { label: 'Keep Source Formatting', icon: 'paste', shortcut: `${MOD_KEY}+V`, disabled: !state.paste, onSelect: () => pasteAs('keep') },
      { label: 'Merge Formatting', icon: 'paste', shortcut: chord('Cmd+Option+Shift+V'), disabled: !state.paste, onSelect: () => pasteAs('merge') },
      { label: 'Keep Text Only', icon: 'pasteText', disabled: !state.paste, onSelect: () => pasteAs('text') },
      { separator: true },
      { label: 'Paste Special…', shortcut: chord('Cmd+Ctrl+V'), disabled: !state.paste, onSelect: () => pasteSpecial() },
    ];
  }
  function attach(engine) {
    if (!engine || engine.formatPasteAttached) return;
    engine.formatPasteAttached = true;
    original = engine.pasteData.bind(engine);
    engine.pasteData = (text, html = '') => {
      const before = engine.session.revision;
      original(text, html);
      if (engine.session.revision !== before && (text || html)) remember(engine, { text, html }, html ? 'keep' : 'text');
    };
    engine.input.addEventListener('keydown', e => { if (chip && !['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) hideChip(); });
    engine.input.addEventListener('pointerdown', hideChip);
  }

  /* ---- Format painter keyboard ---- */
  let copiedFormat = null;
  function copyFormatting() {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    copiedFormat = captureFormat(engine.model);
    toast('Formatting copied. Select text and press ' + chord('Cmd+Shift+V') + ' to apply it.', { icon: 'formatPainter' });
  }
  function pasteFormatting() {
    if (!copiedFormat) return false;
    run(m => applyFormat(m, copiedFormat));
    return true;
  }

  /* ---- Dictation ---- */
  const dictation = createDictation({ editor, readOnly, host, error, onState: () => refreshChrome() });

  /* ---- Ribbon, menus and context menu ---- */
  const commands = {
    fontDialog: () => fontDialog(), textEffectsDialog, paragraphDialog, tabsDialog, bordersDialog, paragraphBorderItems, applyLastBorder: () => setBorders(lastBorder, { toggle: false }),
    bulletsAndNumbering, defineBullet: () => listCommand(openDefineBullet, 'bullet'), defineNumberFormat: () => listCommand(openDefineNumberFormat, 'number'),
    defineMultilevelList: defineMultilevel, setNumberingValue, adjustListIndents: adjustIndents,
    continueNumbering: () => run(m => { if (!continueNumbering(m)) throw new Error('There is no earlier numbered list to continue.'); }),
    restartNumberingAtOne: () => run(m => m.restartNumbering(1)),
    stylesPane: () => stylesPane('styles'), styleInspector: () => stylesPane('inspector'), revealFormatting: () => stylesPane('reveal'), stylesPaneVisible: () => pane.visible,
    applyStyles: applyStylesBox, styleDialog, newStyle, changeCaseDialog: () => { if (ready()) track(openChangeCase({ onClose: later, apply: mode => transact(m => changeCase(m, mode)) })); },
    selectObjects, selectSimilar, selectItems: () => [
      { label: 'Select Objects', icon: 'select', disabled: !editor(), onSelect: selectObjects },
      { label: 'Select All Text With Similar Formatting', disabled: !editor(), onSelect: selectSimilar },
    ],
    pasteItems, pasteSpecial, pasteMatchFormatting: () => pasteAs('merge'), pasteAs, copyFormatting, pasteFormatting,
    advancedFind: () => advancedFind(), dictate: () => dictation.toggle(), dictationSupported: () => dictation.supported, dictating: () => dictation.active,
    listLibraryExtras: kind => kind === 'bullet'
      ? [{ separator: true }, { label: 'Define New Bullet…', onSelect: () => listCommand(openDefineBullet, 'bullet') }]
      : [{ separator: true }, { label: 'Define New Number Format…', onSelect: () => listCommand(openDefineNumberFormat, 'number') }, { label: 'Set Numbering Value…', disabled: editor()?.model.listFormatting !== 'number', onSelect: setNumberingValue }],
    styleGroupItems: ({ command, when }) => {
      const button = command('Styles Pane', 'stylesPane', () => stylesPane('styles'), { size: 'large', text: 'Styles Pane', shortcut: chord('Cmd+Option+Shift+S'), attrs: { 'aria-pressed': 'false' } });
      button.addEventListener('mousedown', e => e.preventDefault());
      when(button, () => !!editor(), () => String(pane.visible && pane.view === 'styles'));
      return [button];
    },
    extendTab(tabId, kit) {
      if (tabId !== 'home' || !dictation.supported) return [];
      const button = kit.command('Dictate', 'dictate', () => dictation.toggle(), { size: 'large', text: 'Dictate', attrs: { 'aria-pressed': 'false' } });
      button.addEventListener('mousedown', e => e.preventDefault());
      kit.when(button, () => !readOnly(), () => String(dictation.active));
      return [{ id: 'voice', label: 'Voice', icon: 'dictate', priority: 1, after: 'styles', items: [button] }];
    },
    extendMenu(menuId) {
      const has = !!editor(), editable = !!ready();
      if (menuId === 'format') return [
        { label: 'Font…', icon: 'fontDialog', shortcut: `${MOD_KEY}+D`, disabled: !has, onSelect: () => fontDialog() },
        { label: 'Text Effects…', icon: 'textEffects', disabled: !editable, onSelect: textEffectsDialog },
        { label: 'Paragraph…', icon: 'paragraphDialog', shortcut: MAC ? 'Cmd+Option+M' : null, disabled: !has, onSelect: () => paragraphDialog() },
        { separator: true },
        { label: 'Bullets and Numbering…', icon: 'bullets', disabled: !editable, onSelect: () => bulletsAndNumbering() },
        { label: 'Borders and Shading…', icon: 'borders', disabled: !has, onSelect: () => bordersDialog() },
        { separator: true },
        { label: 'Tabs…', icon: 'tabStop', disabled: !has, onSelect: tabsDialog },
        { label: 'Change Case…', icon: 'changeCase', disabled: !editable, onSelect: () => commands.changeCaseDialog() },
        { separator: true },
        { label: 'Style…', icon: 'stylesPane', disabled: !has, onSelect: styleDialog },
      ];
      if (menuId === 'edit') return [
        { label: 'Paste Special…', shortcut: chord('Cmd+Ctrl+V'), disabled: !editable, onSelect: pasteSpecial },
        { label: 'Paste and Match Formatting', shortcut: chord('Cmd+Option+Shift+V'), disabled: !editable, onSelect: () => pasteAs('merge') },
        { label: 'Advanced Find and Replace…', disabled: !has, onSelect: () => advancedFind() },
        { label: 'Select', items: [{ label: 'Select Objects', disabled: !has, onSelect: selectObjects }, { label: 'Select All Text With Similar Formatting', disabled: !has, onSelect: selectSimilar }] },
        ...(dictation.supported ? [{ label: dictation.active ? 'Stop Dictation' : 'Start Dictation…', disabled: !editable, onSelect: () => dictation.toggle() }] : []),
      ];
      if (menuId === 'view') return [
        { label: 'Styles Pane', checked: pane.visible && pane.view === 'styles', disabled: !has, onSelect: () => stylesPane('styles') },
        { label: 'Reveal Formatting', shortcut: MAC ? 'Shift+F1' : 'Shift+F1', checked: pane.visible && pane.view === 'reveal', disabled: !has, onSelect: () => stylesPane('reveal') },
        { label: 'Style Inspector', checked: pane.visible && pane.view === 'inspector', disabled: !has, onSelect: () => stylesPane('inspector') },
      ];
      return [];
    },
    contextMenuItems(context) {
      const engine = editor(); if (!engine) return [];
      const editable = !!ready();
      if (context === 'text') return [
        { label: 'Font…', shortcut: `${MOD_KEY}+D`, onSelect: () => fontDialog() },
        { label: 'Paragraph…', onSelect: () => paragraphDialog() },
        { label: 'Bullets and Numbering…', disabled: !editable, onSelect: () => bulletsAndNumbering() },
        { label: 'Styles', items: [...engine.model.paragraphStyles.filter(s => !s.error).slice(0, 12).map(s => ({ label: styleDisplayName(s.name), radio: true, checked: engine.model.paragraphStyle === s.id, disabled: !editable, onSelect: () => applyStyle(s.id) })), { separator: true }, { label: 'Styles Pane…', onSelect: () => stylesPane('styles') }] },
        { label: 'Select Text with Similar Formatting', onSelect: selectSimilar },
      ];
      if (context === 'list') {
        const numbered = engine.model.listFormatting === 'number';
        return [
          ...(numbered ? [{ label: 'Restart at 1', disabled: !editable, onSelect: commands.restartNumberingAtOne },
            { label: 'Continue Numbering', disabled: !editable || !previousList(engine.model), onSelect: commands.continueNumbering },
            { label: 'Set Numbering Value…', disabled: !editable, onSelect: setNumberingValue }] : []),
          { label: 'Adjust List Indents…', disabled: !editable, onSelect: adjustIndents },
        ];
      }
      return [];
    },
  };

  /* ---- Keyboard ---- */
  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !e.target?.matches?.('.canvas-input') || !editor()) return;
    const mod = MAC ? e.metaKey : e.ctrlKey, code = e.code;
    const act = action => { e.preventDefault(); e.stopPropagation(); action(); };
    // Paragraph dialog: Cmd+Option+M on a Mac (Ctrl+Alt+M is New Comment elsewhere).
    if (MAC && e.metaKey && e.altKey && !e.shiftKey && code === 'KeyM') return act(() => paragraphDialog());
    if (mod && e.altKey && e.shiftKey && code === 'KeyS') return act(() => stylesPane('styles'));
    if (mod && !e.altKey && e.shiftKey && code === 'KeyS') return act(applyStylesBox);
    if (mod && !e.altKey && e.shiftKey && code === 'KeyC') return act(copyFormatting);
    // With formatting copied, Cmd+Shift+V pastes it; otherwise it keeps pasting text only.
    if (mod && !e.altKey && e.shiftKey && code === 'KeyV' && copiedFormat) return act(pasteFormatting);
    if (mod && e.altKey && e.shiftKey && code === 'KeyV') return act(() => pasteAs('merge'));
    if (MAC ? e.metaKey && e.ctrlKey && !e.altKey && code === 'KeyV' : e.ctrlKey && e.altKey && !e.shiftKey && code === 'KeyV') return act(pasteSpecial);
    if (e.shiftKey && !mod && !e.altKey && e.key === 'F1') return act(() => stylesPane('reveal'));
  }, { capture: true, signal: keyAbort.signal });

  let commandsRef = () => commands;
  /** Join the editor's full command set: list and effects menus gain this area's dialogs. */
  function install(all) {
    commandsRef = () => all;
    const multilevel = all.multilevelItems, effects = all.textEffectItems;
    all.multilevelItems = () => [...(multilevel?.() || []), { separator: true }, { label: 'Define New Multilevel List…', disabled: !ready(), onSelect: defineMultilevel }];
    all.textEffectItems = () => [...(effects?.() || []), { separator: true }, { label: 'Text Effects…', icon: 'textEffects', disabled: !ready(), onSelect: textEffectsDialog }];
  }
  return { commands, findApi, pane, attach, install,
    refresh() {
      pane.refresh();
      const engine = editor();
      // A highlight of several instances clears once the selection moves on.
      if (highlighted && engine && (engine.model.range[0] !== highlighted.start || engine.model.range[1] !== highlighted.end)) { highlighted = null; if (!finder()?.node || finder().node.hidden) engine.setFindHighlights([]); }
      if (lastPaste && engine && lastPaste.revision !== engine.session.revision) { lastPaste = null; hideChip(); }
    },
    destroy() { keyAbort.abort(); dictation.destroy(); hideChip(); modal?.close?.(); } };
}

/** Shortcuts this area adds, for the keyboard shortcut list. */
export const FORMAT_SHORTCUTS = [
  [chord('Cmd+D'), 'Font dialog'], [MAC ? 'Cmd+Option+M' : '', 'Paragraph dialog'], [chord('Cmd+Option+Shift+S'), 'Styles pane'], [chord('Cmd+Shift+S'), 'Apply Styles'],
  [chord('Cmd+Shift+C'), 'Copy formatting'], [chord('Cmd+Shift+V'), 'Paste formatting'], [chord('Cmd+Option+Shift+V'), 'Paste and match formatting'], [chord('Cmd+Ctrl+V'), 'Paste Special'], ['Shift+F1', 'Reveal Formatting'],
].filter(([key]) => key);
export { CASE_MODES };
