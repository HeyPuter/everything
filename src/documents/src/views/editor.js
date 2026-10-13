import { MAX_FONT_SIZE } from '../engine/font-size.js';
import { stepFontSize, FALLBACK_SIZES } from '../lib/fontsize.js';
import { previewNotice, pictureFontNotice, scriptFontNotice } from './preview-notice.js';
import { createCanvasRulers } from '../ui/canvas-rulers.js';
import { openParagraphBorders, paragraphBorderLabel } from './paragraph-borders.js';
import { openCellAlignment } from './cell-alignment.js';
import { openCellShading, cellShadingLabel } from './cell-shading.js';
import { openCellBorders, cellBorderLabel } from './cell-borders.js';
import { openCellMargins, cellMarginLabel } from './cell-margins.js';
import { openRowHeight, rowHeightLabel } from './row-height.js';
import { openLineSpacing } from './line-spacing.js';
import { CELL_ALIGNMENTS } from '../engine/cell-alignment.js';
import { paragraphFormat } from '../engine/model.js';
import { openParagraphShading, paragraphShadingLabel } from './paragraph-shading.js';
import { openHyperlink } from './hyperlink.js';
import { openBookmarks } from './bookmarks.js';
import { checkedHyperlinkTarget, hyperlinkRanges } from '../engine/hyperlinks.js';
import { openUnderline } from './underline.js';
import { UNDERLINE_STYLES } from '../engine/underlines.js';
import { openKerning } from './kerning.js';
import { openTextWidth } from './text-width.js';
import { openCharacterSpacing } from './character-spacing.js';
import { openBaselineShift } from './baseline-shift.js';
import { openTextHighlight } from './text-highlight.js';
import { HIGHLIGHTS, highlightLabel } from '../engine/backgrounds.js';
import { openTextColor } from './text-color.js';
import { openTableProperties } from './table-properties.js';
import { openImageProperties } from './image-properties.js';
import { openInsertTable } from './insert-table.js';
import { openStyleEditor } from './style-editor.js';
import { createNavigationPane } from './navigation-pane.js';
import { goToTargets, openGoTo } from './go-to.js';
import { findReplacePanel } from './find-replace.js';
import { openParagraphGeometry } from './paragraph-geometry.js';
import { iconEl } from '../ui/icons.js';
import { openPageSetup } from './page-setup.js';
import { el, isComposing, fieldId, MOD_KEY } from '../ui/dom.js';
import { createCanvasChrome } from '../ui/canvas-chrome.js';
import { documentFontAvailable, displayedFont } from '../engine/font-availability.js';
import { openFontPicker } from './font-picker.js';
import { openFontFiles } from './font-files.js';
import { openMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import { confirmDialog, promptDialog } from '../ui/modal.js';
import { saveAsTemplate, templateExists, TEMPLATE_FOLDER } from '../lib/customtemplates.js';
import { openAppMenu, renderAccountButton } from '../ui/appmenu.js';
import { openShortcuts } from '../ui/shortcuts.js';
import { loadEngine } from '../lib/engine.js';
import { session } from '../lib/session.js';
import * as P from '../lib/puter.js';
import { printPages } from '../lib/print.js';
import { templateById } from '../lib/templates.js';
import { autocorrectEnabled, capitalizeSentencesEnabled, correction, sentenceCapital } from '../lib/autocorrect.js';
import { autolinkEnabled, linkCandidateBefore } from '../lib/linkify.js';
import { layoutTemplate } from '../lib/template-layout.js';
import { createWordCommands } from './editor-commands.js';
import { createReview } from './review.js';
import { createReferences } from './references.js';
import { createEditingCommands } from './home-editing-commands.js';
import { engineApi, provideEngineApi } from '../lib/engine-api.js';
import { styleDisplayName } from '../lib/style-names.js';
import { createProofing } from './proofing.js';
import { keyboardShortcuts } from './keyboard-shortcuts.js';
import { commandIconEl } from '../ui/ribbon.js';
import { createFormatArea } from './format-area.js';

/** First canvas milestone. Cloud persistence remains owned by Doc. */
export function editorView({ doc, goHome, newDoc, importFile, local = false }) {
  const printAbort = new AbortController();
  let printing = false;
  window.addEventListener('keydown', e => {
    if (!e.defaultPrevented && !isComposing(e) && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p' && engine) {
      e.preventDefault(); printDocument();
    }
  }, {signal:printAbort.signal});
  async function printDocument() {
    if (!engine || printing) return;
    printing = true; printButton.disabled = true;
    try {
      await engine.fontRefresh;
      const printed = await printPages({ host, signal: printAbort.signal, capture: () => engine.printSheets() });
      if (!printed && !destroyed) error(new Error('The document could not be prepared for printing. Please try again.'));
    } catch (e) { if (!destroyed) error(e); }
    finally { printing = false; if (!destroyed) printButton.disabled = !engine; }
  }
  // The clipboard commands the context menu and the Edit menu share. Each works on the selection as it was when
  // chosen: a write that resolves after the selection or document moved on leaves the document alone.
  const clipboardState = () => {
    if (!engine) return { cut: false, copy: false, paste: false };
    const image = engine.model.selectedImage, editable = !pkg.readOnly;
    const textSelected = engine.model.range[0] !== engine.model.range[1] && !image;
    return { cut: editable && textSelected, copy: textSelected, paste: editable && !image };
  };
  const copyText = async cut => {
    const editor = engine; if (!editor) return;
    const selection = [...editor.model.range], revision = editor.session.revision;
    try {
      const text = editor.model.text.slice(...selection), { html } = editor.clipboardData();
      if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      } else await navigator.clipboard.writeText(text);
      if (cut && !destroyed && engine === editor && revision === editor.session.revision && JSON.stringify(selection) === JSON.stringify(editor.model.range)) editor.execute(() => editor.model.replace(''));
    } catch (e) { if (!destroyed) error(e); }
    if (!destroyed) engine?.focus();
  };
  // Paste without formatting: the clipboard's text only, on the conventional Ctrl/Cmd+Shift+V chord.
  const pastePlainText = async () => {
    const editor = engine; if (!editor || pkg.readOnly) return;
    const selection = [...editor.model.range], revision = editor.session.revision;
    try {
      const text = await navigator.clipboard.readText();
      if (!destroyed && engine === editor && revision === editor.session.revision && JSON.stringify(selection) === JSON.stringify(editor.model.range)) editor.pasteData(text, '');
      if (!destroyed) engine?.focus();
    } catch (e) { if (!destroyed) error(e); }
  };
  const pasteText = async () => {
    const editor = engine; if (!editor) return;
    const selection = [...editor.model.range], revision = editor.session.revision;
    try {
      let text = '', html = '', picture = null;
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
          if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          const type = item.types.find(t => /^image\/(png|jpeg|tiff)$/i.test(t));
          if (!picture && type) picture = new File([await item.getType(type)], `pasted.${type.split('/')[1]}`, { type });
        }
      } else text = await navigator.clipboard.readText();
      if (!destroyed && engine === editor && revision === editor.session.revision && JSON.stringify(selection) === JSON.stringify(editor.model.range)) {
        if (picture && !text) await editor.insertImageFile(picture);
        else editor.pasteData(text, html);
      }
      if (!destroyed) engine?.focus();
    } catch (e) { if (!destroyed) error(e); }
  };
  function openDocumentContextMenu({event,behind,selectBehind}) {
    if(!engine) return;
    const image=engine.model.selectedImage,editable=!pkg.readOnly;
    const arrange=direction=>{engine.execute(()=>engine.model.arrangeImage(direction));engine.focus();};
    const clipboard=clipboardState();
    const items=[{label:'Undo',shortcut:`${MOD_KEY}+Z`,disabled:!editable || !engine.session.history.length,onSelect:()=>engine.undo()},
      {label:'Redo',shortcut:`${MOD_KEY}+Shift+Z`,disabled:!editable || !engine.session.future.length,onSelect:()=>engine.redo()},
      {separator:true},
      {label:'Cut',shortcut:`${MOD_KEY}+X`,disabled:!clipboard.cut,onSelect:()=>copyText(true)},
      {label:'Copy',shortcut:`${MOD_KEY}+C`,disabled:!clipboard.copy,onSelect:()=>copyText(false)},
      {label:'Paste',shortcut:`${MOD_KEY}+V`,disabled:!clipboard.paste,onSelect:pasteText},
      {label:'Paste without formatting',shortcut:`${MOD_KEY}+Shift+V`,disabled:!clipboard.paste,onSelect:pastePlainText}];
    if (!image && editable) {
      // Text and list entries come from the areas that own them (contextMenuItems).
      const list = engine.model.selectedParagraphs.some(p => p.list) ? editorCommands.contextMenuItems?.('list') || [] : [];
      items.push({separator:true},...(editorCommands.contextMenuItems?.('text') || []),...(list.length ? [{separator:true},...list] : []),
        {separator:true},{label:engine.model.hyperlink?'Edit link…':'Insert link…',shortcut:`${MOD_KEY}+K`,onSelect:()=>editHyperlink(engine.input)});
    }
    // A misspelled word under the pointer leads with its suggestions.
    if (!image) items.unshift(...proofing.menuItems(engine.model.selection.focus));
    if(image) items.push({separator:true},{label:'Image properties…',disabled:!editable,onSelect:()=>imageProperties.click()},
      {label:'Arrange',disabled:!editable || !image.anchor,items:[
        {label:'Bring forward',onSelect:()=>arrange('forward')},{label:'Send backward',onSelect:()=>arrange('backward')},
        {label:'Bring to front',onSelect:()=>arrange('front')},{label:'Send to back',onSelect:()=>arrange('back')},
        {separator:true},{label:'In front of text',checked:!image.anchor?.behind,onSelect:()=>arrange('inFront')},
        {label:'Behind text',checked:!!image.anchor?.behind,onSelect:()=>arrange('behind')} ]},
      {label:'Delete image',disabled:!editable,onSelect:()=>{engine.execute(()=>engine.model.replace(''));engine.focus();}});
    if (image) {
      const frames = pkg.drawingTextFrames(image, engine.model.assets);
      if (frames.length) items.push({label:'Edit drawing text',disabled:!editable,items:frames.map(frame => ({
        label: `Text frame ${frame.index + 1}`, disabled: !!frame.reason, hint: frame.reason,
        onSelect: async () => {
          const editor = engine;
          try {
            const { openDrawingText } = await import('./drawing-text.js');
            if (!destroyed && engine === editor && editor.model.selectedImage === image) drawingTextModal = openDrawingText({ engine, pkg, image, frame: frame.index });
          } catch (e) { if (!destroyed) error(e); }
        },
      }))});
    }
    if(behind) items.push({separator:true},{label:'Select picture behind text',onSelect:selectBehind});
    // In a table, the row and column commands of Table > Rows & columns are offered here too.
    if (!image && engine.model.tableContext && editable) {
      update();
      const tableItem = value => { const option = tableActions.querySelector(`option[value="${value}"]`);
        return option && { label: option.textContent, disabled: option.disabled, onSelect: () => { tableActions.value = value; tableActions.dispatchEvent(new Event('change')); } }; };
      items.push({separator:true}, ...['addRow', 'addColumn'].map(tableItem), {separator:true}, ...['row', 'column', 'table'].map(tableItem),
        {separator:true}, ...['mergeCells', 'splitCell'].map(tableItem), {label:'Table properties…',onSelect:()=>tableProperties.click()});
    }
    const commentItems = review.contextItems();
    if (commentItems.length) items.push({separator:true}, ...commentItems);
    if (engine.session.path === null && engine.model.hasBodyFields) items.push({separator:true},{label:'Update page references',disabled:!editable,onSelect:()=>engine.updatePageReferences()});
    items.push({separator:true},{label:'Print / Save as PDF',onSelect:printDocument});
    const rect=engine.input.getBoundingClientRect();
    // A right-click or long press opens with no item chosen; the ContextMenu key and Shift+F10 start on the first.
    const pointer=!!event.pointerType || event.button===2;
    openMenu({anchor:engine.input,x:event.clientX || rect.left,y:event.clientY || rect.bottom,label:image?'Image menu':'Document menu',items,pointer,onClose:()=>engine.focus()});
  }
  let hyperlinkModal = null, bookmarkModal = null, paragraphShadingModal = null, paragraphBorderModal = null;
  let rulers = null;
  let drawingTextModal = null;
  let engine = null, pkg = null, decodedPictures = null, destroyed = false, failed = false, pageSetupModal = null, paragraphModal = null, styleModal = null, tableModal = null, imageModal = null, fontPopover = null, colorPalette = null, highlightPalette = null, baselineModal = null, characterSpacingModal = null, textWidthModal = null, kerningModal = null, underlineModal = null;
  const releasePictures = () => { for (const image of decodedPictures?.values() || []) image.close(); decodedPictures?.clear(); decodedPictures = null; };
  const title = el('input.canvas-title', { value: doc.name, 'aria-label': 'Document name', title: `${doc.name} — Rename`, dir: 'auto', maxLength: 120 });
  const status = el('button.canvas-save-status.save-status', { type: 'button', 'aria-live': 'polite', onclick: () => {
    if (pkg?.readOnly) return;
    if (!failed && session.signedOut) session.signIn();
    else if (doc.exporter) save();
  } }, 'Opening…');
  const account = el('button.user-btn', { type: 'button', 'aria-label': 'Account', 'aria-haspopup': 'menu', onclick: () => openAppMenu(account) });
  if (!local) renderAccountButton(account);
  const stats = el('span.ed-status-item.ed-page-count', {}, '');
  const words = el('span', {}, '');
  const message = el('div.canvas-message', { role: 'status' }, 'Opening document…');
  // Notices about the open document form a message bar the user can put away; new notices bring it back.
  const dismissNotices = el('button.icon-btn.canvas-message-close', { type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => { message.hidden = true; engine?.focus(); } }, iconEl('x', 16));
  const showNotices = () => {
    dismissNotices.remove();
    message.hidden = !message.childElementCount;
    if (!message.hidden && !failed) message.prepend(dismissNotices);
  };
  const host = el('div.canvas-host', { 'aria-label': 'Document pages' });
  const surface = el('div.canvas-document-surface', {}, host);
  const editHyperlink = (anchor = hyperlink, options = {}) => {
    if (!(anchor instanceof HTMLElement)) anchor = hyperlink;
    if (!engine) return; engine.finishComposition();
    if (!anchor.getClientRects().length) anchor = engine.input;
    hyperlinkModal = openHyperlink({ anchor, ...options, link: engine.model.hyperlink?.link, bookmarks: engine.bookmarks, insert: engine.model.range[0] === engine.model.range[1] && !engine.model.hyperlink,
      apply: (target, text) => engine?.setHyperlink(target, text, { appearance: !engine.model.hyperlink }), remove: () => engine?.removeHyperlink(), open: () => engine?.openHyperlink() });
  };
  const button = (label, action, attrs = {}) => el('button.btn', { type: 'button', onclick: action, ...attrs }, label);
  // A tool with a shortcut names it in its tooltip and carries it for the menus that list the same command.
  const tool = (label, name, action, { shortcut = null, ...attrs } = {}) => el('button.icon-btn.canvas-tool', { type: 'button', disabled: true, 'aria-label': label, title: shortcut ? `${label} (${shortcut})` : label, dataset: { icon: name, ...(shortcut ? { shortcut } : {}) }, onclick: action, ...attrs }, iconEl(name, 19));
  const openInput = el('input', { type: 'file', accept: '.docx', hidden: true, 'aria-label': 'Open DOCX file', onchange: () => {
    const file = openInput.files?.[0]; openInput.value = '';
    if (file) importFile(file);
  } });
  const error = e => toast(e?.message || String(e), { icon: 'alert', duration: 8000 });
  const download = async () => {
    try {
      await ready;
      if (!engine || failed || destroyed) return;
      if (pkg.readOnly) { P.downloadBlob(doc.blob, P.ensureDocx(doc.name)); return; }
      engine.finishComposition();
      P.downloadBlob(engine.export(pkg), P.ensureDocx(title.value || 'Untitled document'));
      renderStatus('Downloaded', 'download');
    } catch (e) { error(e); }
  };
  const save = async () => {
    if (pkg?.readOnly) return download();
    if (local) return download();
    try {
      await ready;
      if (!engine || destroyed) return;
      engine.finishComposition();
      if (session.signedOut && !await session.signIn()) return;
      await doc.save();
    } catch (e) { error(e); }
  };
  // A copy of the document as it stands goes to the templates folder; the document itself is unchanged.
  const saveTemplate = async () => {
    try {
      await ready;
      if (!engine || failed || destroyed || pkg.readOnly) return;
      engine.finishComposition();
      if (session.signedOut && !await session.signIn()) return;
      const name = await promptDialog({ title: 'Save as template', label: 'Template name', value: title.value.trim() || 'Untitled document',
        confirmLabel: 'Save template', hint: `Saved in ${TEMPLATE_FOLDER}. Start a new document from it with Templates on the documents screen.` });
      if (!name || destroyed || !engine) return;
      const overwrite = await templateExists(name);
      if (overwrite && !await confirmDialog({ title: 'Replace template?', message: `A template named "${name}" already exists. Replace it with this document?`, confirmLabel: 'Replace' })) return;
      if (destroyed || !engine) return;
      const saved = await saveAsTemplate(engine.export(pkg), name, { overwrite });
      toast(`Saved as template "${saved.name}"`, { icon: 'check' });
    } catch (e) { if (!destroyed) error(e); }
    if (!destroyed) engine?.focus();
  };
  const undo = tool('Undo', 'undo', () => engine?.undo(), { disabled: true, shortcut: `${MOD_KEY}+Z` });
  const redo = tool('Redo', 'redo', () => engine?.redo(), { disabled: true, shortcut: `${MOD_KEY}+Shift+Z` });
  // Format area: Font/Paragraph/Tabs/Borders/Bullets/Style dialogs, Styles pane, paste options, Dictate.
  const formatArea = createFormatArea({ editor: () => engine, pkg: () => pkg, error, refresh: () => chrome?.refresh(), host: () => host, unit: () => rulers?.unit ?? 'in',
    focus: () => engine?.focus(), openFind: options => openFind(options), finder: () => finder, pageSetup: () => pageSetup.click(), clipboard: { state: () => clipboardState() } });
  const finder = findReplacePanel({ ...formatArea.findApi, readOnly: () => !!pkg?.readOnly, matches: (text, options) => engine?.model.findMatches(text, options) || [], range: () => engine?.model.range || [0, 0], select: match => engine?.selectMatch(match), highlight: matches => engine?.setFindHighlights(matches), replace: (...args) => engine?.replaceMatches(...args), close: () => { find.setAttribute('aria-expanded', 'false'); engine?.focus(); } });
  const openFind = (options = {}) => {
    if (!engine) return;
    engine.finishComposition();
    if (window.matchMedia('(max-width: 700px)').matches) {
      chrome.closeInspector();
    }
    outlinePanel.hide(); outline.setAttribute('aria-expanded', 'false');
    find.setAttribute('aria-expanded', 'true'); finder.open(engine.model.text.slice(...engine.model.range), options);
  };
  finder.node.id = 'canvas-find-panel';
  const find = tool('Find and replace', 'search', openFind, { 'aria-expanded': 'false', 'aria-controls': finder.node.id, shortcut: `${MOD_KEY}+F` });
  const bold = tool('Bold', 'bold', () => engine?.toggleBold(), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+B` });
  const italic = tool('Italic', 'italic', () => engine?.toggleItalic(), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+I` });
  const hyperlink = tool('Insert or edit link', 'link', editHyperlink, { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+K` });
  hyperlink.openPopover = editHyperlink;
  hyperlink.setAttribute('aria-haspopup', 'dialog');
  const unlink = tool('Remove link', 'unlink', () => engine?.removeHyperlink(), { disabled: true });
  const bookmarks = tool('Bookmarks', 'bookmark', () => {
    if (!engine) return; engine.finishComposition();
    bookmarkModal = openBookmarks({ entries: () => engine?.bookmarks || [], add: name => engine?.addBookmark(name), rename: (id, name) => engine?.renameBookmark(id, name), remove: id => engine?.removeBookmark(id), navigate: id => engine?.goToBookmark(id) });
  });
  const underline = tool('Underline', 'underline', () => engine?.toggleUnderline(), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+U` });
  const clearTextFormatting = tool('Clear direct text formatting', 'clearFormat', () => engine?.clearDirectTextFormatting(), { shortcut: `${MOD_KEY}+Space`, title: `Clear direct text formatting (${MOD_KEY}+Space). Keep styles and links.` });
  const underlineOptions = tool('Underline options', 'chevD', () => {
    if (!engine) return; engine.finishComposition();
    underlineModal = openUnderline(engine.model.runFormatting, patch => engine?.setRunFormat(patch));
  });
  const caps = tool('All caps', 'caps', () => engine?.setRunFormat({ capitalization: engine.model.runFormatting.capitalization === 'caps' ? 'normal' : 'caps' }), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+Shift+A` });
  const smallCaps = tool('Small caps', 'smallCaps', () => engine?.setRunFormat({ capitalization: engine.model.runFormatting.capitalization === 'smallCaps' ? 'normal' : 'smallCaps' }), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+Shift+K` });
  const strike = tool('Strikethrough', 'strike', () => engine?.setRunFormat({ strikethrough: engine.model.runFormatting.strikethrough === 'single' ? 'none' : 'single' }), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+Shift+X` });
  const doubleStrike = tool('Double strikethrough', 'strikeDouble', () => engine?.setRunFormat({ strikethrough: engine.model.runFormatting.strikethrough === 'double' ? 'none' : 'double' }), { disabled: true, 'aria-pressed': 'false' });
  const script = value => { if (engine) engine.setRunFormat({ verticalAlign: engine.model.runFormatting.verticalAlign === value ? 'baseline' : value }); };
  const superscript = tool('Superscript', 'sup', () => script('superscript'), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+Shift+=` });
  const subscript = tool('Subscript', 'sub', () => script('subscript'), { disabled: true, 'aria-pressed': 'false', shortcut: `${MOD_KEY}+=` });
  const kerning = tool('Kerning', 'fitWidth', () => {
    if (!engine) return; engine.finishComposition();
    kerningModal = openKerning(engine.model.runFormatting.kerning, kerning => engine?.setRunFormat({ kerning }));
  });
  const textWidth = tool('Text width', 'expand', () => {
    if (!engine) return; engine.finishComposition();
    textWidthModal = openTextWidth(engine.model.runFormatting.textScale, textScale => engine?.setRunFormat({ textScale }));
  });
  const characterSpacing = tool('Character spacing', 'fitWidth', () => {
    if (!engine) return; engine.finishComposition();
    characterSpacingModal = openCharacterSpacing(engine.model.runFormatting.characterSpacing, characterSpacing => engine?.setRunFormat({ characterSpacing }));
  });
  const baselineShift = tool('Baseline shift', 'sort', () => {
    if (!engine) return; engine.finishComposition();
    baselineModal = openBaselineShift(engine.model.runFormatting.baselineShift, baselineShift => engine?.setRunFormat({ baselineShift }));
  });
  const textColor = tool('Text color', 'textColor', () => textColor.openPalette(textColor), { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  textColor.openPalette = (anchor, options) => {
    if (!engine) return; engine.finishComposition();
    colorPalette = openTextColor(engine.model.runFormatting.color, color => engine?.setRunFormat({ color }), { anchor, ...options });
  };
  const paragraphBorders = tool('Paragraph borders', 'table', () => {
    if (!engine) return; engine.finishComposition();
    paragraphBorderModal = openParagraphBorders(engine.model.selectedParagraphs.map(p => paragraphFormat(p, engine.model.numbering).paragraphBorders), paragraphBorders => {
      const ok = engine.execute(() => engine.model.setParagraphFormat({ paragraphBorders })); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    });
  });
  const paragraphShading = tool('Paragraph shading', 'paint', () => paragraphShading.openPalette(paragraphShading), { 'aria-haspopup': 'menu' });
  paragraphShading.openPalette = (anchor, options) => {
    if (!engine) return; engine.finishComposition();
    paragraphShadingModal = openParagraphShading(engine.model.paragraphFormatting.paragraphShading, paragraphShading => engine?.setParagraphFormat({ paragraphShading }), { anchor, ...options });
  };
  const highlight = tool('Text highlight', 'highlight', () => highlight.openPalette(highlight), { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  highlight.openPalette = (anchor, options) => {
    if (!engine) return; engine.finishComposition();
    highlightPalette = openTextHighlight(engine.model.runFormatting.highlight, highlight => engine?.setRunFormat({ highlight }), { anchor, ...options });
  };
  for (const control of [textColor, highlight]) {
    control.classList.add('canvas-color-tool');
    control.replaceChildren(el('span.canvas-color-icon', {}, control.firstChild,
      el('span.canvas-color-indicator', { 'aria-hidden': 'true' })), iconEl('chevD', 12));
    control.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); control.openPalette(control); }
    });
  }
  async function refreshAvailableFonts(fontEditor) {
    await fontEditor.refreshFonts();
    if (destroyed || engine !== fontEditor) return;
    for (const warning of message.querySelectorAll('[data-picture-font-warning]')) warning.remove();
    message.append(...pictureFontNotice({ missingPictureFonts: fontEditor.missingPictureFonts || [] }));
    showNotices();
    update();
  }
  const fontFamily = el('button.canvas-font-label', { type: 'button', disabled: true, 'aria-label': 'Latin font family', 'aria-haspopup': 'dialog', onclick: () => fontFamily.openPopover(fontFamily) }, 'Noto Sans');
  fontFamily.openPopover = (anchor, options) => {
    if (!engine) return; engine.finishComposition();
    const fontEditor = engine;
    const run = engine.model.runFormatting;
    fontPopover = openFontPicker({ anchor, ...options, value: run.fontAscii === run.fontHAnsi ? run.fontAscii : null,
      onFontsAvailable: () => refreshAvailableFonts(fontEditor),
      alternatives: engine.model.styles.fontAlternatives, apply: name => engine?.setRunFormat({ fontAscii: name, fontHAnsi: name }) });
  };
  let fontSizeDraftCancelled = false;
  function applyFontSize() {
    if (!engine) return false;
    if (fontSizeDraftCancelled) return true;
    if (!fontSize.value || !fontSize.checkValidity()) { fontSize.reportValidity(); update(); return false; }
    engine.setFontSize(Number(fontSize.value));
    update();
    return true;
  }
  function cancelFontSizeDraft(e) {
    e.preventDefault(); e.stopPropagation();
    // Restore before blur so the change event cannot apply a cancelled draft.
    fontSizeDraftCancelled = true;
    fontSize.value = engine?.model.runFormatting.fontSize ?? '';
    engine?.focus(); update();
  }
  // The usual sizes as suggestions, like a word processor's size box; any size can still be typed.
  const fontSizes = el('datalist', { id: fieldId('canvas-font-sizes') }, ...FALLBACK_SIZES.map(size => el('option', { value: size })));
  const fontSize = el('input.canvas-spacing', { type: 'number', min: 1, max: MAX_FONT_SIZE, step: 0.5, disabled: true, 'aria-label': 'Font size (pt)', placeholder: 'Mixed', list: fontSizes.id, onchange: applyFontSize,
    oninput: () => { fontSizeDraftCancelled = false; },
    onkeydown: e => {
      if (isComposing(e)) return;
      if (e.key === 'Escape') cancelFontSizeDraft(e);
      else if (e.key === 'Enter') { e.preventDefault(); fontSizeDraftCancelled = false; if (applyFontSize()) engine?.focus(); }
    },
    // A native suggestion popup can consume Escape's keydown while leaving the
    // size field focused. Its keyup still cancels the draft.
    onkeyup: e => { if (e.key === 'Escape' && !isComposing(e) && document.activeElement === fontSize) cancelFontSizeDraft(e); },
  });
  const paragraphStyle = el('select.canvas-style-select', { disabled: true, 'aria-label': 'Paragraph style', onchange: () => engine?.setParagraphStyle(paragraphStyle.value) });
  const clearParagraphFormatting = tool('Clear direct paragraph formatting', 'eraser', () => engine?.clearDirectParagraphFormatting(), { title: 'Clear direct paragraph formatting, including numbering. Keep text formatting and styles.' });
  const outlinePanel = createNavigationPane({ navigate: id => engine?.goToParagraph(id), close: () => toggleOutline(false), focusEditor: () => engine?.focus(),
    goToPage: index => {
      if (!engine) return;
      const target = goToTargets(engine, 'page')[index];
      if (!target) return;
      engine.finishComposition();
      if (engine.session.path !== null) engine.editStory(null);
      engine.model.select(target.position); engine.caretAffinity = 'forward'; engine.caretPage = null;
      engine.focus(); engine.revealCaret(); engine.onSelection();
    },
    pages: () => engine?.canvases || [], currentPage: () => engine?.caretPageIndex ?? 0,
    search: text => { try { return engine?.model.findMatches(text, {}) || []; } catch { return []; } },
    text: () => engine?.model.text || '', selectMatch: match => engine?.selectMatch(match), highlight: matches => engine?.setFindHighlights(matches) });
  outlinePanel.node.id = 'canvas-outline-panel';
  function toggleOutline(visible = outlinePanel.node.hidden, { search = false } = {}) {
    outline.setAttribute('aria-expanded', String(visible));
    if (visible && engine) {
      if (window.matchMedia('(max-width: 700px)').matches) chrome.closeInspector();
      finder.close();
      outlinePanel.refresh(engine.outline, engine.model.range[0]);
      outlinePanel.open({ focus: !search });
      if (search) outlinePanel.focusSearch();
    } else { outlinePanel.hide(); outline.focus(); }
  }
  /** Ctrl/Cmd+F and Home → Find: the Navigation pane's search, seeded with a short selection. */
  const openSearch = () => {
    if (!engine) return;
    engine.finishComposition();
    const [start, end] = engine.model.range, selected = engine.model.text.slice(start, end);
    toggleOutline(true, { search: true });
    if (selected && !/[\n\f\v]/.test(selected) && selected.length <= 255) outlinePanel.setSearch(selected);
  };
  const outline = tool('Document outline', 'outline', () => toggleOutline(), { 'aria-expanded': 'false', 'aria-controls': outlinePanel.node.id, shortcut: `${MOD_KEY}+Alt+O` });
  const outlineLevel = el('select', { disabled: true, 'aria-label': 'Outline level', title: 'Outline level does not change text formatting', onchange: () => engine?.setOutlineLevel(outlineLevel.value === 'inherit' ? null : Number(outlineLevel.value)) },
    el('option', { value: 'mixed', disabled: true }, 'Mixed levels'), el('option', { value: 'inherit' }, 'Use style level'),
    ...Array.from({ length: 9 }, (_, i) => el('option', { value: i }, `Level ${i + 1}`)), el('option', { value: 9 }, 'Body text'));
  let styleOptionsSignature = '';
  const editStyle = tool('Edit paragraph style', 'pencil', () => {
    if (!engine) return; engine.finishComposition();
    const id = engine.model.paragraphStyle, style = engine.model.styles.definitions[id];
    if (!style) return;
    styleModal = openStyleEditor(style, engine.model.paragraphStyles, patch => {
      const ok = engine.editParagraphStyle(id, patch); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    });
  });
  const newStyle = tool('New paragraph style', 'plus', () => {
    if (!engine) return; engine.finishComposition();
    styleModal = openStyleEditor({ basedOn: engine.model.paragraphStyle }, engine.model.paragraphStyles, patch => {
      const ok = engine.createParagraphStyle(patch.name, patch.basedOn); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    });
  });
  const characterStyle = el('select.canvas-style-select', { disabled: true, 'aria-label': 'Character style', onchange: () => engine?.setCharacterStyle(characterStyle.value) });
  let characterOptionsSignature = '';
  const editCharacterStyle = tool('Edit character style', 'pencil', () => {
    if (!engine) return; engine.finishComposition();
    const id = engine.model.characterStyle, style = engine.model.styles.definitions[id];
    if (!style || style.type !== 'character') return;
    styleModal = openStyleEditor(style, engine.model.characterStyles, patch => {
      const ok = engine.editCharacterStyle(id, patch); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    }, engine.model.styles.defaults.run);
  });
  const newCharacterStyle = tool('New character style', 'plus', () => {
    if (!engine) return; engine.finishComposition();
    styleModal = openStyleEditor({ type: 'character', basedOn: engine.model.characterStyle }, engine.model.characterStyles, patch => {
      const ok = engine.createCharacterStyle(patch.name, patch.basedOn); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    });
  });
  const alignments = ['left', 'center', 'right', 'both'];
  const alignmentButtons = alignments.map((value, i) => tool(value === 'both' ? 'Justify' : `Align ${value}`, value === 'both' ? 'alignJustify' : `align${value[0].toUpperCase() + value.slice(1)}`, () => engine?.setParagraphFormat({ alignment: value }), { 'aria-pressed': 'false', shortcut: `${MOD_KEY}+${'LERJ'[i]}` }));
  const lineSpacing = el('select', { disabled: true, 'aria-label': 'Line spacing', onchange: () => {
    if (lineSpacing.value) engine?.setParagraphFormat({ lineRule: 'auto', lineSpacing: Number(lineSpacing.value) });
  } }, ...[1, 1.15, 1.5, 2, 2.5, 3].map(value => el('option', { value }, `${value}×`)));
  const customLine = el('option', { value: '', disabled: true }, 'Mixed');
  lineSpacing.prepend(customLine);
  const lineSpacingOptions = tool('Line spacing options', 'sort', () => {
    if (!engine) return; engine.finishComposition();
    paragraphModal = openLineSpacing(engine.model.paragraphFormatting, value => engine.setParagraphLineSpacing(value), () => queueMicrotask(() => engine?.focus()));
  });
  const lineSpacingMenu = tool('Line spacing', 'sort', () => lineSpacingMenu.openPalette(lineSpacingMenu), { 'aria-haspopup': 'menu' });
  lineSpacingMenu.openPalette = (anchor, options) => {
    if (!engine) return; engine.finishComposition();
    const format = engine.model.paragraphFormatting;
    return openMenu({ anchor, ...options, label: 'Line spacing', items: [
      ...[1, 1.15, 1.5, 2, 2.5, 3].map(value => ({ label: `${value}×`, radio: true, checked: format.lineRule === 'auto' && format.lineSpacing === value,
        onSelect: () => engine?.setParagraphFormat({ lineRule: 'auto', lineSpacing: value }) })),
      { separator: true }, { label: 'Custom spacing…', onSelect: () => lineSpacingOptions.click() },
    ] });
  };
  const spacingInput = (key, label) => {
    const input = el('input.canvas-spacing', { type: 'number', min: 0, max: 600, step: 'any', disabled: true, 'aria-label': label, placeholder: 'Mixed', onchange: () => {
      if (input.value === '' || !input.checkValidity()) { input.reportValidity(); update(); return; }
      engine?.setParagraphFormat({ [key]: Number(input.value) });
    } });
    return input;
  };
  const spaceBefore = spacingInput('spaceBefore', 'Space before paragraph (pt)');
  const spaceAfter = spacingInput('spaceAfter', 'Space after paragraph (pt)');
  const pageSetup = tool('Page setup', 'pageSettings', () => {
    if (!engine) return;
    engine.finishComposition();
    pageSetupModal = openPageSetup(engine.model.pageSettings, settings => {
      const ok = engine.setPageSettings(settings);
      if (ok) queueMicrotask(() => engine?.focus());
      return ok;
    });
  }, { disabled: true });
  const pageBreak = tool('Page break', 'insertPageBreak', () => engine?.insertPageBreak(), { disabled: true, shortcut: `${MOD_KEY}+Enter`, title: `Insert page break (${MOD_KEY}+Enter)` });
  const pageBreakBefore = tool('Start paragraph on new page', 'header', () => engine?.setParagraphFormat({ pageBreakBefore: engine.model.paragraphFormatting.pageBreakBefore !== true }), { 'aria-pressed': 'false' });
  const paginationTools = [
    ['contextualSpacing', 'Contextual paragraph spacing', 'listView'],
    ['keepNext', 'Keep with next paragraph', 'merge'],
    ['keepLines', 'Keep lines together', 'rows'],
    ['widowControl', 'Widow and orphan control', 'rowsSplit'],
  ].map(([key, label, icon]) => ({ key, button: tool(label, icon, () => engine?.setParagraphFormat({ [key]: engine.model.paragraphFormatting[key] !== true }), { 'aria-pressed': 'false' }) }));
  const outdent = tool('Decrease indent', 'outdent', () => engine?.changeListLevel(-1));
  const indent = tool('Increase indent', 'indent', () => engine?.changeListLevel(1));
  const paragraphGeometry = tool('Indents and tabs', 'ruler', () => {
    if (!engine) return;
    engine.finishComposition();
    paragraphModal = openParagraphGeometry(engine.model.paragraphFormatting, engine.model.pageSettings.defaultTabStop, (patch, defaultTabStop) => {
      const ok = engine.setParagraphGeometry(patch, defaultTabStop);
      if (ok) queueMicrotask(() => engine?.focus());
      return ok;
    });
  });
  const bullets = tool('Bulleted list', 'bullets', () => engine?.toggleList('bullet'), { 'aria-pressed': 'false', shortcut: `${MOD_KEY}+Shift+8` });
  const numbers = tool('Numbered list', 'numbers', () => engine?.toggleList('number'), { 'aria-pressed': 'false', shortcut: `${MOD_KEY}+Shift+7` });
  const restart = tool('Restart numbering at 1', 'history', () => engine?.restartNumbering());
  const imageInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/tiff,.tif,.tiff', hidden: true, 'aria-label': 'Insert image file', onchange: async () => {
    const file = imageInput.files?.[0]; imageInput.value = '';
    try { if (file && engine) await engine.insertImageFile(file); } catch (e) { error(e); }
  } });
  const insertImage = tool('Insert image', 'image', () => imageInput.click());
  const imageProperties = tool('Image properties', 'settings', () => {
    if (!engine?.model.selectedImage) return; engine.finishComposition();
    imageModal = openImageProperties(engine.model.selectedImage, (patch,signal) => {
      if (engine.pictureEditor?.canResize(engine.model.selectedImage)) return Object.keys(patch).length ? engine.pictureEditor.resize(patch,{signal}) : true;
      const ok = engine.setImageProperties(patch); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    }, { canResize: engine.pictureEditor?.canResize(engine.model.selectedImage) });
  });
  const insertTable = tool('Insert table', 'table', () => insertTable.openPalette(insertTable), { 'aria-haspopup': 'menu' });
  insertTable.openPalette = (anchor, options) => {
    if (!engine) return; engine.finishComposition();
    tableModal = openInsertTable((rows, columns) => {
      // With text selected, the table goes after the selection rather than replacing it.
      const [start, end] = engine.model.range;
      if (start !== end) { engine.model.select(end); engine.syncInput(); }
      const ok = engine.insertTable(rows, columns);
      if (!ok && start !== end) { engine.model.select(start, end); engine.syncInput(); }
      if (ok) queueMicrotask(() => engine?.focus()); return ok;
    }, { anchor, ...options });
  };
  const tableProperties = tool('Table properties', 'ruler', () => {
    if (!engine?.model.tableContext) return; engine.finishComposition();
    const { table, column } = engine.model.tableContext;
    const widths = engine.layout.tableWidths[table.id].map(w => w * 15);
    tableModal = openTableProperties(table, widths, column, patch => {
      const ok = engine.setTableProperties(patch); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    });
  });
  const keepRow = tool('Keep table row together', 'rows', () => engine?.setTableRowKeep(engine.model.tableRowKeep !== true), { 'aria-pressed': 'false' });
  const rowHeight = tool('Row height', 'rows', () => {
    if (!engine?.model.selectedTableRows.length) return; engine.finishComposition();
    tableModal = openRowHeight(engine.model.tableRowHeight, value => engine.setTableRowHeight(value), () => queueMicrotask(() => engine?.focus()));
  });
  const cellAlignment = tool('Cell alignment', 'sort', () => {
    if (!engine?.model.selectedTableCells.length) return; engine.finishComposition();
    tableModal = openCellAlignment(engine.model.cellVerticalAlignment, value => {
      const ok = engine.setCellVerticalAlignment(value); if (ok) queueMicrotask(() => engine?.focus()); return ok;
    }, () => queueMicrotask(() => engine?.focus()));
  });
  const cellShading = tool('Cell shading', 'paint', () => {
    if (!engine?.model.selectedTableCells.length) return; engine.finishComposition();
    tableModal = openCellShading(engine.model.cellShading, value => engine.setCellShading(value), () => queueMicrotask(() => engine?.focus()));
  });
  const cellBorders = tool('Cell borders', 'table', () => {
    if (!engine?.model.selectedTableCells.length) return; engine.finishComposition();
    tableModal = openCellBorders(engine.model.cellBorderValues, value => engine.setCellBorders(value), () => queueMicrotask(() => engine?.focus()));
  });
  const cellMargins = tool('Cell margins', 'ruler', () => {
    if (!engine?.model.selectedTableCells.length) return; engine.finishComposition();
    tableModal = openCellMargins(engine.model.selectedTableCells, value => engine.setCellMargins(value), () => queueMicrotask(() => engine?.focus()));
  });
  const tableActions = el('select', { disabled: true, 'aria-label': 'Table actions', onchange: () => {
    const action = tableActions.value; tableActions.value = '';
    if (action === 'fitContents' || action === 'fitPage') engine?.fitTable(action === 'fitContents' ? 'contents' : 'page');
    else if (action === 'repeatHeader') engine?.setTableHeaderRows(engine.model.headerRowsThroughSelection);
    else if (action === 'clearHeader') engine?.setTableHeaderRows(0);
    else if (action === 'mergeCells') engine?.mergeCells();
    else if (action === 'mergeBelow') engine?.mergeCellBelow();
    else if (action === 'splitCell') engine?.splitCell();
    else if (action === 'addRow') engine?.insertTableRow();
    else if (action === 'addColumn') engine?.insertTableColumn();
    else if (action === 'before' || action === 'after') engine?.insertTableParagraph(action === 'after');
    else if (action) engine?.deleteTablePart(action);
  } }, ...[['', 'Table actions'], ['repeatHeader', 'Repeat rows through selection'], ['clearHeader', 'Remove repeated headers'], ['mergeCells', 'Merge cells in row'], ['mergeBelow', 'Merge with cell below'], ['splitCell', 'Split into grid cells'], ['fitContents', 'Fit to contents'], ['fitPage', 'Fit to page'], ['addRow', 'Insert row below'], ['addColumn', 'Insert column right'], ['row', 'Delete row'], ['column', 'Delete column'], ['table', 'Delete table'], ['before', 'Insert paragraph before table'], ['after', 'Insert paragraph after table']].map(([value, label]) => el('option', { value }, label)));
  const insertTab = tool('Insert tab', 'tab', () => engine?.insertTab(), { title: 'Insert tab (Tab)' });
  const exportButton = button('Download .docx', download, { disabled: true, className: 'btn btn-primary' });
  const printButton = button('Print / Save as PDF', printDocument, { disabled: true });
  const saveButton = button('Save to Puter', save, { disabled: true });
  const templateButton = button('Save as template…', saveTemplate, { disabled: true });
  // Choosing any other zoom leaves View → Multiple Pages.
  const singlePages = () => engine?.pages.classList.remove('is-multipage');
  const zoom = el('select', { 'aria-label': 'Zoom', onchange: () => { singlePages(); if (zoom.value === 'fit') fitWidth(); else engine?.setZoom(Number(zoom.value)); syncZoom(); } },
    el('option', { value: 'fit' }, 'Fit width'),
    ...[0.5, 0.75, 1, 1.25, 1.5, 2].map(n => el('option', { value: n, selected: n === 1 }, `${n * 100}%`)));
  if (window.matchMedia('(max-width: 700px)').matches) zoom.value = 'fit';
  // A zoom from the slider or the Zoom dialog that is not a preset shows as one more choice.
  const customZoom = el('option', { value: 'custom', hidden: true });
  zoom.append(customZoom);
  const zoomControl = {
    set(value) {
      singlePages();
      if (value === 'fit') { zoom.value = 'fit'; fitWidth(); syncZoom(); return; }
      const scale = Math.max(0.1, Math.min(2, Number(value)));
      const preset = [...zoom.options].find(o => o !== customZoom && Number(o.value) === scale);
      if (preset) zoom.value = preset.value;
      else { customZoom.value = String(scale); customZoom.textContent = `${Math.round(scale * 100)}%`; customZoom.hidden = false; zoom.value = customZoom.value; }
      engine?.setZoom(scale); syncZoom();
    },
  };
  const zoomSlider = el('input.ed-zoom-slider', { type: 'range', min: 10, max: 200, step: 1, value: 100, 'aria-label': 'Zoom slider', oninput: () => zoomControl.set(Number(zoomSlider.value) / 100), onchange: () => engine?.focus() });
  const zoomStep = (label, icon, delta) => el('button.icon-btn.ed-zoom-step', { type: 'button', 'aria-label': label, title: label, onclick: () => {
    const now = Math.round((engine?.zoom ?? 1) * 100), next = delta > 0 ? Math.floor(now / 10) * 10 + 10 : Math.ceil(now / 10) * 10 - 10;
    zoomControl.set(Math.max(10, Math.min(200, next)) / 100);
  } }, commandIconEl(icon, 12));
  const zoomOut = zoomStep('Zoom Out', 'zoomOut', -1), zoomIn = zoomStep('Zoom In', 'zoomIn', 1);
  function syncZoom() { if (engine) zoomSlider.value = String(Math.round(engine.zoom * 100)); }
  function fitWidth() {
    if (!engine || zoom.value !== 'fit' || !host.clientWidth) return;
    const style = getComputedStyle(engine.pages);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const width = Math.max(...engine.layout.pages.map(page => page.width));
    const scale = Math.max(0.1, Math.min(2, (host.clientWidth - padding - 2) / width));
    if (Math.abs(engine.zoom - scale) > 0.001) engine.setZoom(scale);
    syncZoom();
  }
  let fitObserver;
  const editingArea = el('select', { 'aria-label': 'Editing area', onchange: () => {
    const [path, page] = editingArea.value ? JSON.parse(editingArea.value) : [null, 0];
    try { engine?.editStory(path, page); } catch (e) { error(e); }
  } });
  const editingAreaLabel = el('label.canvas-zoom.canvas-story-area', {}, 'Editing ', editingArea);
  let editingAreaSignature;
  const textMode = el('input', { type: 'checkbox', onchange: () => { engine?.setAccessible(textMode.checked); rulers?.update(); } });
  for (const b of [undo, redo, bold, italic, underline, underlineOptions, caps, smallCaps, strike, doubleStrike, superscript, subscript, ...alignmentButtons, pageBreak, pageBreakBefore, ...paginationTools.map(t => t.button), outdent, indent, insertTab, bullets, numbers, restart, keepRow]) b.addEventListener('mousedown', e => e.preventDefault());
  // The toolbar's pickers keep the document focused when clicked, so a picker the mouse opened closes
  // back into the text; opened from the keyboard, it returns to its button.
  for (const b of [textColor, highlight, lineSpacingMenu, insertTable, fontFamily, hyperlink]) b.addEventListener('mousedown', e => { if (engine && document.activeElement === engine.input) e.preventDefault(); });
  let root = null;
  const editorCommands = createWordCommands({ editor: () => engine, pkg: () => pkg, error, zoomControl, fitWidth, openFind, root: () => root, focus: () => engine?.focus() });
  editorCommands.drawingTextItems = () => {
    const image = engine?.model.selectedImage;
    if (!image || !pkg) return [];
    return pkg.drawingTextFrames(image, engine.model.assets).map(frame => ({ label: `Text frame ${frame.index + 1}`, disabled: !!frame.reason || !!pkg.readOnly, hint: frame.reason,
      onSelect: async () => {
        const editor = engine;
        try {
          const { openDrawingText } = await import('./drawing-text.js');
          if (!destroyed && engine === editor && editor.model.selectedImage === image) drawingTextModal = openDrawingText({ engine, pkg, image, frame: frame.index });
        } catch (e) { if (!destroyed) error(e); }
      } }));
  };
  const editingCommands = createEditingCommands({ editor: () => engine, pkg: () => pkg, host: () => host, refresh: () => chrome?.refresh(), zoomControl, error, editDrawingText: () => editorCommands.drawingTextItems()?.find(item => !item.disabled)?.onSelect(), documentTitle: () => title?.value?.trim() });
  // The format area's extendTab, extendMenu and contextMenuItems arrive here too; later modules chain onto them.
  Object.assign(editorCommands, editingCommands, formatArea.commands);
  formatArea.install(editorCommands);
  // The proofing indicator: the book shows whether spelling found errors; clicking opens the Spelling pane.
  const proofingButton = el('button.ed-status-item.ed-proofing', { type: 'button', onclick: () => proofing.openPane() }, commandIconEl('proofingClean', 16));
  const languageLabel = el('span.ed-status-item.ed-status-language', { title: 'English (United States)' }, 'English (United States)');
  function updateProofingStatus() {
    const summary = proofing.enabled ? proofing.summary : null;
    const label = !proofing.enabled ? 'Spelling check is off' : !summary ? 'Checking spelling' : summary.errors ? `Spelling: ${summary.overflow ? 'too many errors to show' : `${summary.errors} ${summary.errors === 1 ? 'error' : 'errors'} found`}. Select to review.` : 'Spelling: no errors';
    proofingButton.title = label; proofingButton.setAttribute('aria-label', label);
    const state = !proofing.enabled ? 'off' : !summary ? 'pending' : summary.errors ? 'errors' : 'clean';
    if (proofingButton.dataset.state !== state) { proofingButton.dataset.state = state; proofingButton.replaceChildren(commandIconEl(state === 'errors' ? 'proofingErrors' : 'proofingClean', 16)); }
  }
  const proofing = createProofing({ editor: () => engine, pkg: () => pkg, error, onState: () => { chrome?.refresh(); updateProofingStatus(); } });
  Object.assign(editorCommands, {
    goTo: () => { if (engine) { engine.finishComposition(); openGoTo(engine, { onClose: () => queueMicrotask(() => engine?.focus()) }); } },
    spelling: () => proofing.openPane(),
    spellingItems: () => [
      { label: 'Spelling', icon: 'spell', shortcut: 'F7', onSelect: () => proofing.openPane() },
      { label: 'Check Spelling as You Type', checked: proofing.enabled, onSelect: () => proofing.setEnabled(!proofing.enabled) },
      { label: 'Recheck Document', disabled: !proofing.enabled, onSelect: () => proofing.recheck() },
    ],
  });
  const references = createReferences({ editor: () => engine, pkg: () => pkg, error, onChange: () => update(),
    base: { canEditHeader: editorCommands.canEditHeader, editHeader: editorCommands.editHeader, canUpdateFields: editorCommands.canUpdateFields, updateFields: editorCommands.updateFields } });
  Object.assign(editorCommands, references.commands);
  const baseContextTabs = editorCommands.contextTabs;
  editorCommands.contextTabs = kit => [...(baseContextTabs?.(kit) || []), ...references.contextTabs(kit)];
  const baseFileItems = editorCommands.fileItems;
  editorCommands.fileItems = () => [...(baseFileItems?.() || []), { label: 'Save as PDF…', icon: 'pdf', disabled: !engine || failed, onSelect: savePdf }];
  async function savePdf() {
    const editor = engine; if (!editor) return;
    try {
      editor.finishComposition();
      const { exportPdf } = await import('../lib/pdf-export.js');
      const name = P.ensureDocx(title.value || 'Untitled document').replace(/\.docx$/i, '.pdf');
      P.downloadBlob(await exportPdf(editor, { title: title.value || 'Untitled document' }), name);
    } catch (e) { if (!destroyed) error(e); }
  }
  const review = createReview({ editor: () => engine, pkg: () => pkg, host: () => (engine && !failed ? host : null), error, author: () => session.username, onChange: () => update(), onShift: () => { fitWidth(); rulers?.update(); } });
  const baseExtendTab = editorCommands.extendTab;
  editorCommands.extendTab = (id, kit) => [...(baseExtendTab?.(id, kit) || []), ...review.extendTab(id, kit), ...references.extendTab(id, kit)];
  const chrome = createCanvasChrome({ title, status, account, local, focusEditor: () => engine?.focus(), commands: editorCommands,
    controls: { undo, redo, find, paragraphStyle, editStyle, newStyle, clearParagraphFormatting, outline, outlineLevel,
      characterStyle, editCharacterStyle, newCharacterStyle, clearTextFormatting, fontFamily, fontSize, bold, italic, underline,
      underlineOptions, caps, smallCaps, strike, doubleStrike, superscript, subscript, baselineShift, characterSpacing,
      textWidth, kerning, textColor, highlight, alignmentButtons, lineSpacing, lineSpacingOptions, lineSpacingMenu, spaceBefore, spaceAfter,
      bullets, numbers, restart, hyperlink, unlink, bookmarks, insertImage, imageProperties, insertTable, tableActions,
      tableProperties, cellAlignment, cellShading, cellBorders, cellMargins, rowHeight, keepRow, outdent, indent,
      paragraphGeometry, paragraphBorders, paragraphShading, insertTab, pageSetup, pageBreak, pageBreakBefore,
      paginationTools: paginationTools.map(t => t.button), exportButton, printButton, saveButton, templateButton, zoom, textMode },
    rulers: { get visible() { return rulers?.visible ?? true; }, toggle: () => rulers?.toggle(), get unit() { return rulers?.unit ?? 'in'; }, setUnit: unit => rulers?.setUnit(unit) },
    actions: { loadFontFiles: () => { if (engine) { const fontEditor = engine; fontPopover = openFontFiles({ anchor: document.activeElement, onFontsAvailable: () => refreshAvailableFonts(fontEditor) }); } }, closeFind: () => finder.close(), closeOutline: () => { outlinePanel.hide(); outline.setAttribute('aria-expanded', 'false'); }, openSearch, goHome: () => goHome?.(), newDocument: () => newDoc?.(), openDocument: () => openInput.click(),
      selectAll: () => { if (engine) { engine.finishComposition(); engine.model.select(0, engine.model.text.length); engine.focus(); update(); } },
      clipboardState, cut: () => copyText(true), copy: () => copyText(false), paste: pasteText, pastePlain: pastePlainText, hasDocument: () => !!engine && !failed },
  });
  const wordCountButton = el('button.ed-status-item', { type: 'button', title: 'Word Count', onclick: () => editorCommands.wordCount() }, words);
  const focusButton = el('button.ed-status-item', { type: 'button', title: 'Focus', 'aria-label': 'Focus', onclick: () => editorCommands.focusMode() }, commandIconEl('focusArrow', 14), el('span', {}, 'Focus'));
  const printLayoutButton = el('button.icon-btn.ed-status-view', { type: 'button', 'aria-label': 'Print Layout', title: 'Print Layout', 'aria-pressed': 'true', onclick: () => engine?.focus() }, commandIconEl('printLayoutSolid', 16));
  root = el('section.canvas-workspace.ed-workspace', {}, chrome.header, chrome.toolbar,
    message, el('div.canvas-editor-body', {}, chrome.navigation,
      el('div.canvas-editor-content', {}, outlinePanel.node, finder.node, surface, review.pane, formatArea.pane.node, proofing.pane, chrome.inspector)),
    el('footer.canvas-statusbar.ed-statusbar', {}, el('div.ed-status-left', {}, stats, wordCountButton, proofingButton, languageLabel, editingAreaLabel),
      el('div.ed-status-right', {},
        el('label.canvas-text-mode', { title: 'Edit the text in a plain text field without page layout, for screen readers and other assistive tools' }, textMode, 'Text mode'),
        focusButton, printLayoutButton,
        el('div.ed-zoom', {}, zoomOut, zoomSlider, zoomIn, el('label.canvas-zoom', {}, el('span.visually-hidden', {}, 'Zoom '), zoom))),
      el('span.visually-hidden', { id: 'canvas-input-help' }, `Tab moves between table cells · Escape then Tab to leave · ${MOD_KEY}+Enter page break · Shift+Enter line break`)),
    openInput, imageInput, fontSizes);
  /** A bullet or number typed with a space at the start of a paragraph that is not yet a list item. */
  const listMarker = (before, typed, list) => {
    if (list || typed !== ' ') return null;
    if (/^[*\-•] $/.test(before)) return { back: 2, text: '', list: 'bullet' };
    if (/^1[.)] $/.test(before)) return { back: 3, text: '', list: 'number' };
    return null;
  };
  /** The paragraph style the heading chords name: level 0 is Normal, 1 to 9 the built-in headings. */
  const styleForLevel = level => {
    const wanted = level === 0 ? 'normal' : `heading ${level}`;
    const styles = engine?.model.paragraphStyles || [];
    return styles.find(s => !s.error && String(s.name || '').toLowerCase() === wanted) || styles.find(s => !s.error && s.id.toLowerCase() === wanted.replace(' ', ''));
  };
  const stepSize = dir => {
    const size = engine.model.runCommandFormatting.fontSize;
    if (size === null || size === undefined) return;
    engine.setFontSize(Math.min(MAX_FONT_SIZE, stepFontSize(size, dir)));
  };
  // The conventional word-processor formatting chords, beyond the engine's own (Cmd+B, I, U, Z, Y, A,
  // K, J and Cmd+Space). Each goes through the toolbar's control, so a command disabled for this selection stays
  // inert, and only while the keyboard is in the document: the same keys mean other things in a field.
  const formattingShortcut = e => {
    if (!engine || !(e.ctrlKey || e.metaKey) || !host.contains(e.target)) return null;
    const code = e.code || '', shift = e.shiftKey, alt = e.altKey;
    if (shift && !alt) {
      const chords = { KeyX: strike, KeyA: caps, KeyK: smallCaps, Equal: superscript, Digit8: bullets, Digit7: numbers,
        KeyL: alignmentButtons[0], KeyR: alignmentButtons[2], KeyJ: alignmentButtons[3] };
      // Shift+E is Track Changes (review.js), not Center.
      if (chords[code]) return () => chords[code].click();
      if (code === 'Period') return () => stepSize(1);
      if (code === 'Comma') return () => stepSize(-1);
      return null;
    }
    if (!shift && !alt) {
      const chords = { Period: superscript, Comma: subscript, Equal: subscript, Backslash: clearTextFormatting,
        KeyL: alignmentButtons[0], KeyE: alignmentButtons[1], KeyR: alignmentButtons[2] };
      return chords[code] ? () => chords[code].click() : null;
    }
    if (alt && !shift) {
      if (code === 'KeyO') return () => outline.click();
      const level = /^Digit([0-9])$/.exec(code)?.[1];
      if (level === undefined || paragraphStyle.disabled) return null;
      const style = styleForLevel(Number(level));
      return style ? () => engine?.setParagraphStyle(style.id) : null;
    }
    return null;
  };
  // The paragraph and navigation chords run before the engine's own keys (Alt+Shift+Up moves a paragraph).
  root.addEventListener('keydown', keyboardShortcuts({ editor: () => engine, pkg: () => pkg,
    applyStyleLevel: level => { const style = !paragraphStyle.disabled && styleForLevel(level); if (style) engine?.setParagraphStyle(style.id); },
    focusFont: () => fontFamily.click(), focusSize: () => { fontSize.focus(); fontSize.select(); } }), true);
  root.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && engine) { e.preventDefault(); openSearch(); return; }
    // Find and replace: the conventional Ctrl+H; Cmd+H hides the app on a Mac, so there it is Cmd+Shift+H.
    if (e.code === 'KeyH' && !e.altKey && engine && (MOD_KEY === 'Cmd' ? e.metaKey && e.shiftKey : e.ctrlKey && !e.shiftKey)) { e.preventDefault(); openFind(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '/') { e.preventDefault(); openShortcuts(); return; }
    if (e.key === 'F7' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && engine) { e.preventDefault(); proofing.openPane(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && e.code === 'KeyV' && engine && host.contains(e.target)) { e.preventDefault(); pastePlainText(); return; }
    const action = formattingShortcut(e);
    if (action) { e.preventDefault(); action(); }
  });

  let scriptMetricSignature;
  function update() {
    if (!engine || destroyed) return;
    const scriptSignature = JSON.stringify(engine.approximateScriptFonts || []);
    if (scriptSignature !== scriptMetricSignature) {
      for (const warning of message.querySelectorAll('[data-script-font-warning]')) warning.remove();
      message.append(...scriptFontNotice(engine.approximateScriptFonts));
      showNotices();
      scriptMetricSignature = scriptSignature;
    }
    fitWidth(); rulers?.update();
    const areas = (engine.storyLayout.positions || []).filter(item => engine.pageStories.stories[item.path].editable);
    const areaSignature = JSON.stringify(areas.map(item => [item.path, item.page]));
    if (areaSignature !== editingAreaSignature) {
      editingArea.replaceChildren(el('option', { value: '' }, 'Body'), ...areas.map(item => el('option', { value: JSON.stringify([item.path, item.page]) }, `${{ header: 'Header', footer: 'Footer', footnote: 'Footnote' }[engine.pageStories.stories[item.path].kind] || 'Story'} · page ${item.page + 1}`)));
      editingAreaSignature = areaSignature;
    }
    editingAreaLabel.hidden = pkg.readOnly || !areas.length;
    const selectedArea = engine.session.path === null ? '' : JSON.stringify([engine.session.path, engine.storyPage]);
    if (editingArea.value !== selectedArea) editingArea.value = selectedArea;
    outline.disabled = false; outlinePanel.refresh(engine.outline, engine.model.range[0]);
    chrome.setContext(engineApi()?.selectedShape(engine) ? 'shape' : engine.model.selectedImage ? 'image' : engine.model.tableContext ? 'table' : 'paragraph', ['header', 'footer'].includes(references.activeStoryKind()) ? ['headerFooter'] : []);
    if (pkg.readOnly) {
      for (const control of [...chrome.toolbar.querySelectorAll('button, input, select'), ...chrome.inspector.querySelectorAll('button.canvas-tool, input, select')]) control.disabled = true;
      find.disabled = false; finder.refresh();
      stats.textContent = `Page ${Math.min(engine.layout.pageCount, (engine.caretPageIndex ?? 0) + 1)} of ${engine.layout.pageCount}`;
      words.textContent = 'Read only';
      chrome.refresh(); review.refresh();
      return;
    }
    undo.disabled = !engine.session.history.length;
    redo.disabled = !engine.session.future.length;
    find.disabled = false; finder.refresh();
    hyperlink.disabled = false; hyperlink.setAttribute('aria-pressed', String(!!engine.model.hyperlink));
    bookmarks.disabled = engine.session.path !== null;
    // Remove link is available only where there is a link: at the caret or anywhere in the selection.
    const [linkStart, linkEnd] = engine.model.range;
    unlink.disabled = !engine.model.hyperlink && (linkStart === linkEnd || !hyperlinkRanges(engine.model.paragraphs).some(r => r.start < linkEnd && r.end > linkStart));
    // "No style" shows as the document's default paragraph style (Normal), so it is only listed when there is none.
    const choices = engine.model.paragraphStyles, unstyled = !engine.model.styles.defaultParagraph, signature = JSON.stringify([choices, unstyled]);
    if (signature !== styleOptionsSignature) {
      paragraphStyle.replaceChildren(el('option', { value: '__mixed', disabled: true }, 'Mixed styles'), ...(unstyled ? [el('option', { value: '' }, 'Default paragraph')] : []), ...choices.map(s => el('option', { value: s.id, disabled: !!s.error, title: s.error || styleDisplayName(s.name) }, styleDisplayName(s.name))));
      styleOptionsSignature = signature;
    }
    paragraphStyle.disabled = false; paragraphStyle.value = engine.model.paragraphStyle ?? '__mixed';
    editStyle.disabled = !engine.model.paragraphStyle || !!choices.find(s => s.id === engine.model.paragraphStyle)?.error;
    newStyle.disabled = false;
    const characterChoices = engine.model.characterStyles, characterSignature = JSON.stringify(characterChoices);
    if (characterSignature !== characterOptionsSignature) {
      characterStyle.replaceChildren(el('option', { value: '__mixed', disabled: true }, 'Mixed character styles'), el('option', { value: '' }, 'Default characters'), ...characterChoices.map(s => el('option', { value: s.id, disabled: !!s.error, title: s.error || styleDisplayName(s.name) }, styleDisplayName(s.name))));
      characterOptionsSignature = characterSignature;
    }
    characterStyle.disabled = false; characterStyle.value = engine.model.characterStyle ?? '__mixed';
    editCharacterStyle.disabled = !engine.model.characterStyle || !characterChoices.some(s => s.id === engine.model.characterStyle && !s.error);
    newCharacterStyle.disabled = false;
    insertTable.disabled = !!engine.model.selectedImage;
    insertImage.disabled = false; imageProperties.disabled = !engine.model.selectedImage;
    tableActions.disabled = !engine.model.tableContext; tableProperties.disabled = tableActions.disabled;
    const nestedTable = !!engine.model.tableContext?.table.parentCellId;
    tableActions.querySelector('option[value="fitPage"]').textContent = nestedTable ? 'Fit to cell' : 'Fit to page';
    const repeatHeader = tableActions.querySelector('option[value="repeatHeader"]');
    repeatHeader.disabled = nestedTable;
    repeatHeader.textContent = nestedTable ? 'Nested tables do not repeat their own header rows' : 'Repeat rows through selection';
    tableActions.querySelector('option[value="clearHeader"]').textContent = nestedTable ? 'Remove header flags' : 'Remove repeated headers';
    tableActions.querySelector('option[value="mergeCells"]').disabled = !engine.model.mergeCellsContext;
    tableActions.querySelector('option[value="mergeBelow"]').disabled = !engine.model.mergeBelowContext;
    tableActions.querySelector('option[value="splitCell"]').disabled = !engine.model.canSplitCell;
    tableActions.querySelector('option[value="clearHeader"]').disabled = !engine.model.tableContext?.table.rows.some(row => row.header);
    const columnCount = engine.model.tableContext?.span ?? 1;
    tableActions.querySelector('option[value="column"]').textContent = columnCount > 1 ? `Delete ${columnCount} spanned columns` : 'Delete column';
    keepRow.disabled = !engine.model.selectedTableRows.length;
    rowHeight.disabled = keepRow.disabled;
    rowHeight.title = 'Row height: ' + rowHeightLabel(engine.model.tableRowHeight);
    cellAlignment.disabled = !engine.model.selectedTableCells.length;
    cellAlignment.title = 'Cell alignment: ' + (CELL_ALIGNMENTS[engine.model.cellVerticalAlignment] || 'Mixed');
    cellShading.disabled = !engine.model.selectedTableCells.length;
    cellShading.title = 'Cell shading: ' + cellShadingLabel(engine.model.cellShading);
    cellBorders.disabled = !engine.model.selectedTableCells.length;
    cellBorders.title = 'Cell borders: ' + cellBorderLabel(engine.model.cellBorderValues);
    cellMargins.disabled = !engine.model.selectedTableCells.length;
    cellMargins.title = 'Cell margins: ' + cellMarginLabel(engine.model.selectedTableCells);
    // Outside a table there is nothing to keep together: a state of 'mixed' there would read as a mixed selection.
    keepRow.setAttribute('aria-pressed', !engine.model.selectedTableRows.length ? 'false' : engine.model.tableRowKeep === null ? 'mixed' : String(engine.model.tableRowKeep));
    const run = engine.model.runCommandFormatting;
    clearTextFormatting.disabled = false;
    clearParagraphFormatting.disabled = false;
    for (const [control, key] of [[bold, 'bold'], [italic, 'italic'], [underline, 'underline']]) {
      control.disabled = false;
      control.setAttribute('aria-pressed', run[key] === null ? 'mixed' : String(run[key]));
    }
    for (const [control, mode] of [[caps, 'caps'], [smallCaps, 'smallCaps']]) { control.disabled = false; control.setAttribute('aria-pressed', run.capitalization === null ? 'mixed' : String(run.capitalization === mode)); }
    for (const [control, mode] of [[strike, 'single'], [doubleStrike, 'double']]) { control.disabled = false; control.setAttribute('aria-pressed', run.strikethrough === null ? 'mixed' : String(run.strikethrough === mode)); }
    underlineOptions.disabled = false; underlineOptions.title = `Underline: ${run.underlineStyle === null ? 'Mixed' : UNDERLINE_STYLES[run.underlineStyle]}`;
    kerning.disabled = false; kerning.title = `Kerning: ${run.kerning === null ? 'Mixed' : run.kerning === 0 ? 'Off' : 'from ' + run.kerning + ' pt'}`;
    textWidth.disabled = false; textWidth.title = `Text width: ${run.textScale === null ? 'Mixed' : run.textScale + '%'}`;
    characterSpacing.disabled = false; characterSpacing.title = `Character spacing: ${run.characterSpacing === null ? 'Mixed' : run.characterSpacing + ' pt'}`;
    baselineShift.disabled = false; baselineShift.title = `Baseline shift: ${run.baselineShift === null ? 'Mixed' : run.baselineShift + ' pt'}`;
    highlight.disabled = false; highlight.title = `Text highlight: ${run.highlight === null ? 'Mixed' : highlightLabel(run.highlight)}`;
    for (const [control, value] of [[superscript, 'superscript'], [subscript, 'subscript']]) { control.disabled = false; control.setAttribute('aria-pressed', run.verticalAlign === null ? 'mixed' : String(run.verticalAlign === value)); }
    textColor.disabled = false; textColor.title = `Text color: ${run.color === null ? 'Mixed' : run.color === 'auto' ? 'Automatic' : '#' + run.color}`;
    for (const [control, value, color] of [[textColor, run.color, run.color === 'auto' ? 'currentColor' : `#${run.color}`], [highlight, run.highlight, HIGHLIGHTS[run.highlight] ? `#${HIGHLIGHTS[run.highlight]}` : 'transparent']]) {
      const indicator = control.querySelector('.canvas-color-indicator');
      indicator.style.background = value === null ? '' : color;
      indicator.classList.toggle('is-mixed', value === null);
      indicator.classList.toggle('is-none', control === highlight && value === 'none');
    }
    fontSize.disabled = fontFamily.disabled = false;
    const family = run.fontAscii === run.fontHAnsi ? run.fontAscii : null;
    const substituted = family && documentFontAvailable(family, engine.model.styles.fontAlternatives) === false;
    const replacement = substituted ? displayedFont({ fontFamily: family }, engine.model.styles.fontAlternatives) : family;
    fontFamily.textContent = !family ? 'Mixed fonts' : substituted ? `${family} → ${replacement}` : family;
    fontFamily.title = substituted ? `${family} is unavailable in this browser. Displaying ${replacement}; the original font is retained in the DOCX.` : !family ? 'The selection uses different Latin font declarations.' : `Latin font: ${family}`;
    if (document.activeElement !== fontSize) fontSize.value = run.fontSize ?? '';
    for (const control of [pageSetup, pageBreak, pageBreakBefore, outdent, indent, paragraphGeometry, insertTab, lineSpacingOptions, lineSpacingMenu, ...alignmentButtons]) control.disabled = false;
    pageBreak.disabled = !!engine.model.selectedParagraphs[0]?.cellId;
    pageBreakBefore.disabled = !!engine.model.selectedTableRows.length;
    for (const [control, kind] of [[bullets, 'bullet'], [numbers, 'number']]) {
      control.disabled = false;
      control.setAttribute('aria-pressed', engine.model.listFormatting === 'mixed' ? 'mixed' : String(engine.model.listFormatting === kind));
    }
    restart.disabled = engine.model.listFormatting !== 'number';
    const format = engine.model.paragraphFormatting;
    paragraphBorders.disabled = false; paragraphBorders.title = 'Paragraph borders: ' + paragraphBorderLabel(format.paragraphBorders);
    paragraphShading.disabled = false; paragraphShading.title = 'Paragraph shading: ' + paragraphShadingLabel(format.paragraphShading);
    outline.disabled = false; outlineLevel.disabled = !engine.model.canSetOutlineLevel; outlineLevel.value = format.outlineLevel === null ? 'mixed' : String(format.outlineLevel);
    outlineLevel.title = outlineLevel.disabled ? 'Built-in heading styles have a fixed level. Choose another paragraph style to change it.' : 'Outline level does not change text formatting';
    pageBreakBefore.setAttribute('aria-pressed', format.pageBreakBefore === null ? 'mixed' : String(format.pageBreakBefore));
    for (const { key, button } of paginationTools) {
      button.disabled = false;
      button.setAttribute('aria-pressed', format[key] === null ? 'mixed' : String(format[key]));
    }
    for (const control of [lineSpacing, spaceBefore, spaceAfter]) control.disabled = false;
    alignmentButtons.forEach((control, i) => control.setAttribute('aria-pressed', format.alignment === null ? 'mixed' : String(format.alignment === alignments[i])));
    customLine.textContent = format.lineRule === null || format.lineSpacing === null ? 'Mixed' : format.lineRule === 'auto' ? `${format.lineSpacing}×` : `${format.lineRule === 'exact' ? 'Exactly' : 'At least'} ${format.lineSpacing} pt`;
    lineSpacing.value = format.lineRule === 'auto' && [1, 1.15, 1.5, 2, 2.5, 3].includes(format.lineSpacing) ? String(format.lineSpacing) : '';
    if (document.activeElement !== spaceBefore) spaceBefore.value = format.spaceBefore ?? '';
    if (document.activeElement !== spaceAfter) spaceAfter.value = format.spaceAfter ?? '';
    chrome.refresh(); review.refresh(); formatArea.refresh();
    const total = engine.model.text.trim().split(/\s+/u).filter(Boolean).length;
    const [a, b] = engine.model.range;
    const chosen = a !== b ? engine.model.text.slice(a, b).trim().split(/\s+/u).filter(Boolean).length : null;
    stats.textContent = `Page ${Math.min(engine.layout.pageCount, (engine.caretPageIndex ?? 0) + 1)} of ${engine.layout.pageCount}`;
    words.textContent = chosen !== null ? `${chosen} of ${total} ${total === 1 ? 'word' : 'words'}` : `${total} ${total === 1 ? 'word' : 'words'}`;
  }
  function renderStatus(label, name, state = '') {
    status.className = `canvas-save-status save-status ${state}`;
    status.replaceChildren(iconEl(name, 14), el('span.save-label', {}, label));
    status.title = doc.error ? `${label}: ${doc.error}` : doc.path ? `${label} · ${doc.path}` : label;
    status.setAttribute('aria-label', label);
  }
  function refreshTitle() {
    title.title = `${doc.name} — Rename`;
    title.style.width = `${Math.min(48, Math.max(12, title.value.length + 2))}ch`;
  }
  function updateStatus() {
    if (destroyed || failed) return;
    if (pkg?.readOnly) { renderStatus('Read only', 'monitor'); status.disabled = true; saveButton.disabled = true; return; }
    const signedOut = !local && session.signedOut;
    const [label, name, state] = signedOut ? ['Sign in to save', 'cloud', 'signed-out']
      : doc.status === 'saving' ? ['Saving…', 'spinner', 'saving']
      : doc.status === 'error' ? ['Not saved', 'alert', 'error']
      : doc.status === 'offline' ? ['Offline', 'wifiOff', 'offline']
      : doc.dirty ? ['Unsaved changes', 'cloudOff', 'unsaved']
      : local ? ['On this device', 'monitor', 'local']
      : doc.path ? ['Saved to Puter', 'cloud', 'saved'] : ['Not saved yet', 'cloud', 'unsaved'];
    renderStatus(label, name, state);
    status.disabled = !signedOut && (!doc.exporter || doc.status === 'saving');
    if (doc.exporter) saveButton.disabled = false;
    refreshTitle();
  }
  const onTitle = async () => {
    const name = title.value.trim() || 'Untitled document';
    title.value = name;
    try {
      if (doc.rename) {
        const failure = await doc.rename(name, { stillWanted: () => !destroyed });
        if (failure) throw new Error(failure);
      } else doc.name = name;
      if (destroyed) return;
      title.value = doc.name;
      refreshTitle();
      document.title = `${doc.name} — Documents`;
    } catch (e) { title.value = doc.name; refreshTitle(); error(e); }
  };
  title.addEventListener('change', onTitle);
  title.addEventListener('input', refreshTitle);
  title.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); engine?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); title.value = doc.name; refreshTitle(); title.blur(); engine?.focus(); }
  });
  doc.addEventListener('status', updateStatus);
  const onSession = () => { renderAccountButton(account); updateStatus(); if (session.signedIn && doc.dirty && doc.exporter) doc.save({ auto: true }).catch(error); };
  if (!local) session.addEventListener('change', onSession);
  updateStatus();

  const ready = (async () => {
    const engineModules = await loadEngine();
    provideEngineApi(engineModules);
    const { CanvasEditor, createDocx, WRITING_STYLES, paragraph, openCanvasDocument, loadCanvasFonts, htmlFragment, pasteFragment } = engineModules;
    // Plain text becomes one paragraph per line, without the file's final line ending.
    const imported = doc.pendingImport, importedText = imported?.type === 'text' ? imported.value.replace(/\n+$/, '') : null;
    // Markdown and HTML become headings, lists, paragraphs and character formatting.
    const importedHtml = imported?.type === 'markdown' ? (await import('../lib/markdown-html.js')).markdownHtml(imported.value) : imported?.type === 'html' ? imported.value : null;
    if (imported && importedText === null && importedHtml === null) throw new Error('This file type cannot be opened here. Open a .docx, Markdown, HTML or plain-text file.');
    const template = !doc.blob && doc.template ? templateById(doc.template) : null;
    const opened = doc.blob ? await openCanvasDocument(doc.blob) : { pkg: createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES), images: new Map() };
    pkg = opened.pkg;
    const images = opened.images; decodedPictures = images;
    await loadCanvasFonts();
    if (destroyed) { releasePictures(); return; }
    engine = new CanvasEditor(host, {
      onContextMenu: openDocumentContextMenu,
      onUpdateFields: () => references.updateAllFields(),
      paragraphs: pkg.paragraphs, pageSettings: pkg.pageSettings, numbering: pkg.numbering, styles: pkg.styles, tables: pkg.tables, pageStories: pkg.pageStories, comments: pkg.comments, trackChanges: pkg.trackRevisions, assets: pkg.assets, drawingLayouts: pkg.drawingLayouts, images, readOnly: !!pkg.readOnly,
      onChange: () => { doc.changed(); update(); updateStatus(); proofing.changed(true); },
      onSelection: () => { update(); proofing.selectionChanged(); }, onSave: save, onError: error, onLink: editHyperlink,
      onOpenLink: target => window.open(checkedHyperlinkTarget(target), '_blank', 'noopener,noreferrer'),
      // The account menu's typing settings, read at each keystroke so a change applies at once.
      correctTyping: (before, typed, { list }) => (autocorrectEnabled() && (listMarker(before, typed, list) || correction(before, typed))) || (capitalizeSentencesEnabled() && sentenceCapital(before, typed)) || null,
      linkTyping: (text, end) => autolinkEnabled() ? linkCandidateBefore(text, end) : null,
    });
    if (importedText) {
      // The imported text is the starting point, not an edit: it adds no undo step.
      engine.session.run(() => { engine.model.replace(importedText); engine.model.select(0); }, () => engine.validateStory(), { record: false });
      engine.relayout();
    }
    if (importedHtml !== null) {
      const fragment = htmlFragment(importedHtml);
      if (fragment) {
        // In a new document every imported block keeps its own formatting.
        for (const p of fragment.paragraphs) p.mark = true;
        engine.session.run(() => { pasteFragment(engine.model, fragment); engine.model.select(0); }, () => engine.validateStory(), { record: false });
        engine.relayout();
      }
    }
    if (doc.pendingImport) doc.pendingImport = null;
    if (template) {
      // A template is the starting point, not an edit: laying it out adds no undo step.
      engine.session.run(() => layoutTemplate(engine.model, template.blocks()), () => engine.validateStory(), { record: false });
      engine.relayout();
      doc.template = null;
    }
    editorCommands.restoreMarks(engine);
    formatArea.attach(engine);
    proofing.attach(engine);
    engineApi().attachShapeEditing(engine, error, () => pkg);
    rulers = createCanvasRulers({ host, surface, editor: () => engine, openParagraph: () => paragraphGeometry.click(), openPage: () => pageSetup.click() });
    // In a tablet-sized or narrow window (under 1024px) a page wider than the view at 100% opens at Fit
    // width, as on phones; desktop windows keep 100% and scroll.
    if (zoom.value === '1' && window.innerWidth < 1024) {
      const style = getComputedStyle(engine.pages), widest = Math.max(...engine.layout.pages.map(page => page.width));
      if (host.clientWidth && widest + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) > host.clientWidth) { zoom.value = 'fit'; fitWidth(); }
    }
    fitObserver = new ResizeObserver(() => { fitWidth(); engine?.revealCaret(); }); fitObserver.observe(host);
    if (!pkg.readOnly) doc.attach(async () => {
      if (engine.composition) throw new Error('Finish composing text before saving.');
      return engine.export(pkg);
    });
    if (pkg.fieldsRecalculated && !pkg.readOnly) doc.changed();
    const previewIssues = [...(pkg.previewIssues || []), ...engine.storyLayout.unsupported.map(issue =>
      `${issue.path}, page ${issue.page + 1}: ${issue.message}`)];
    const notices = [...(pkg.readOnly ? previewNotice({ ...pkg, previewIssues }) : []), ...pictureFontNotice(pkg)];
    if (pkg.fieldRefreshIssues?.length) notices.push(el('div', {}, 'Some page references could not be updated. Cached results were retained. ', el('ul', {}, ...[...new Set(pkg.fieldRefreshIssues)].map(issue => el('li', {}, issue)))));
    message.replaceChildren(...notices);
    showNotices();
    exportButton.disabled = false; saveButton.disabled = false; printButton.disabled = false; templateButton.disabled = !!pkg.readOnly;
    update(); updateStatus(); engine.focus();
    document.title = `${doc.name} — Documents`;
  })().catch(e => {
    releasePictures();
    if (destroyed) return;
    failed = true;
    // The header and menus stay, so the user can leave or start again from here.
    root.classList.add('canvas-failed');
    const actions = el('div.canvas-message-actions', {},
      button('Back to documents', () => goHome?.(), { className: 'btn btn-primary' }),
      button('New document', () => newDoc?.(), { className: 'btn btn-outline' }));
    message.replaceChildren(el('p.canvas-message-text', {}, e.message || 'Could not open this document.'), actions);
    message.classList.add('canvas-message-error', 'editor-error');
    host.hidden = true;
    renderStatus('Could not open', 'alert', 'error');
    status.disabled = true;
    // A failed imported copy still has bytes/text worth recovering. No save handler is attached.
    if (doc.template && !doc.blob && !doc.pendingImport) doc.discardEdits();
    if (doc.blob) actions.append(button('Download original', () => P.downloadBlob(doc.blob, P.ensureDocx(doc.name)), { className: 'btn btn-outline' }));
    throw e;
  });
  ready.catch(() => {});
  return {
    el: root, doc, ready,
    get engine() { return engine; },
    async flush() {
      if (destroyed) return true;
      engine?.finishComposition();
      if (!doc.dirty && doc.status !== 'saving') return true;
      if (!doc.exporter) return false;
      try { return await doc.flush(); }
      catch (e) { if (!session.signedOut) error(e); return false; }
    },
    destroy() {
      drawingTextModal?.close();
      printAbort.abort();
      destroyed = true; paragraphBorderModal?.close(); paragraphShadingModal?.close(); bookmarkModal?.close(); hyperlinkModal?.close(); pageSetupModal?.close(); paragraphModal?.close(); styleModal?.close(); tableModal?.close(); imageModal?.close(); fontPopover?.close(); colorPalette?.close(); highlightPalette?.close(); baselineModal?.close(); characterSpacingModal?.close(); textWidthModal?.close(); kerningModal?.close(); underlineModal?.close();
      fitObserver?.disconnect(); rulers?.destroy(); chrome.destroy(); formatArea.destroy(); review.destroy(); references.destroy(); editingCommands.destroy(); proofing.destroy();
      releasePictures();
      doc.removeEventListener('status', updateStatus);
      session.removeEventListener('change', onSession);
      doc.destroy(); engine?.destroy();
    },
  };
}
