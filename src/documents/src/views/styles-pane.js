import { el, isComposing } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { styleRun } from '../engine/styles.js';
import { canvasFontFamily } from '../engine/font-families.js';
import { displayedFont } from '../engine/font-availability.js';
import { styleUsage } from '../engine/style-management.js';
import { revealFormatting, styleInspection } from '../engine/format-inspection.js';
import { styleDisplayName } from '../lib/style-names.js';

/** Styles a desktop word processor recommends first, by name. */
const RECOMMENDED = ['normal', 'no spacing', 'heading 1', 'heading 2', 'heading 3', 'heading 4', 'title', 'subtitle', 'quote', 'intense quote', 'list paragraph', 'emphasis', 'strong', 'subtle emphasis', 'intense emphasis', 'book title', 'caption'];
const PREVIEW_KEY = 'documents.stylesPane.preview', FILTER_KEY = 'documents.stylesPane.filter';
const stored = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };
const VIEWS = { styles: 'Styles', inspector: 'Style Inspector', reveal: 'Reveal Formatting' };
const LABELS = { fontAscii: 'font', fontHAnsi: 'font', fontSize: 'size', bold: 'bold', italic: 'italic', underline: 'underline', underlineStyle: 'underline', underlineColor: 'underline color', color: 'color', strikethrough: 'strikethrough', capitalization: 'capitals', verticalAlign: 'position', baselineShift: 'position', characterSpacing: 'spacing', textScale: 'scale', kerning: 'kerning', highlight: 'highlight', vanish: 'hidden', alignment: 'alignment', indentLeft: 'left indent', indentRight: 'right indent', firstLine: 'special indent', spaceBefore: 'space before', spaceAfter: 'space after', lineSpacing: 'line spacing', lineRule: 'line spacing', keepNext: 'keep with next', keepLines: 'keep lines together', widowControl: 'widow control', pageBreakBefore: 'page break before', tabs: 'tabs', paragraphBorders: 'borders', paragraphShading: 'shading', contextualSpacing: 'contextual spacing', outlineLevel: 'outline level', mirrorIndents: 'mirror indents', textOutline: 'outline', textShadow: 'shadow', textFill: 'text fill' };
const describeKeys = keys => [...new Set(keys.map(k => LABELS[k] || k))].join(', ');

/**
 * The Styles pane, docked beside the pages, with three views: Styles (apply, modify, new, delete, select
 * all instances, filters and previews), Style Inspector (paragraph and character styles plus direct
 * formatting, each with its own clear button) and Reveal Formatting (effective formatting with links into
 * the dialogs that change it).
 *
 * actions: apply(id), modify(id), create(), remove(id), selectAll(id), updateToMatch(id), clearFormatting(),
 * clearParagraph(), clearText(), resetParagraphStyle(), clearCharacterStyle(), openTarget(target), manage(), focusEditor()
 */
export function createStylesPane({ editor, readOnly, actions }) {
  let view = 'styles', signature = '';
  let filter = stored(FILTER_KEY, 'recommended'), showPreview = stored(PREVIEW_KEY, '1') === '1';
  const heading = el('h2', {}, 'Styles');
  const tabs = Object.entries(VIEWS).map(([id, label]) => el('button.styles-pane-tab', { type: 'button', role: 'tab', id: `styles-pane-tab-${id}`, 'aria-controls': 'styles-pane-view', 'aria-selected': 'false', tabindex: -1, dataset: { view: id }, onclick: () => open(id) }, label));
  const body = el('div.styles-pane-body', { role: 'tabpanel', id: 'styles-pane-view' });
  // The views are one tab stop; the arrows, Home and End move between them, as in the dialogs' tab strips.
  const onTabKey = e => {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    const at = tabs.indexOf(e.target);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (at < 0 || next === undefined) return;
    e.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    open(tab.dataset.view); tab.focus();
  };
  const node = el('aside.styles-pane', { 'aria-label': 'Styles pane', hidden: true, onkeydown: e => {
    if (e.key === 'Escape' && !isComposing(e) && !e.defaultPrevented) { e.preventDefault(); close(); actions.focusEditor(); }
  } },
  el('div.canvas-panel-heading', {}, heading, el('button.icon-btn', { type: 'button', 'aria-label': 'Close Styles pane', title: 'Close', onclick: () => { close(); actions.focusEditor(); } }, iconEl('x', 18))),
  el('div.styles-pane-tabs', { role: 'tablist', 'aria-label': 'Styles pane views', onkeydown: onTabKey }, ...tabs), body);

  function open(next = view) {
    view = next; node.hidden = false; signature = '';
    heading.textContent = VIEWS[view];
    for (const tab of tabs) { const on = tab.dataset.view === view; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; if (on) body.setAttribute('aria-labelledby', tab.id); }
    refresh();
  }
  function close() { node.hidden = true; }
  const engine = () => editor();

  function preview(id) {
    const e = engine(); if (!e) return {};
    try {
      const style = e.model.styles.definitions[id];
      const run = styleRun(e.model.styles, id, e.model.styles.defaults.run, style?.type === 'character' ? 'character' : 'paragraph');
      return { fontFamily: canvasFontFamily({ fontFamily: displayedFont({ fontFamily: run.fontAscii }, e.model.styles.fontAlternatives) }), fontWeight: run.bold ? '700' : '', fontStyle: run.italic ? 'italic' : '',
        color: run.color && run.color !== 'auto' ? `#${run.color}` : '', fontSize: `${Math.max(11, Math.min(20, (run.fontSize || 12) * 1.05))}px`, textDecoration: run.underlineStyle && run.underlineStyle !== 'none' ? 'underline' : '' };
    } catch { return {}; }
  }
  function styleList(e) {
    const usage = styleUsage(e.model), definitions = Object.values(e.model.styles.definitions).filter(s => ['paragraph', 'character'].includes(s.type) && !s.error);
    const name = s => String(s.name || s.id).toLowerCase();
    let list = definitions;
    if (filter === 'inUse') list = definitions.filter(s => usage.has(s.id) || s.id === e.model.styles.defaultParagraph);
    else if (filter === 'recommended') list = definitions.filter(s => RECOMMENDED.includes(name(s)) || usage.has(s.id) || s.generated);
    return list.sort((a, b) => {
      const ra = RECOMMENDED.indexOf(name(a)), rb = RECOMMENDED.indexOf(name(b));
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || styleDisplayName(a.name).localeCompare(styleDisplayName(b.name));
    }).map(s => ({ ...s, count: usage.get(s.id) || 0 }));
  }

  function renderStyles(e) {
    const current = e.model.paragraphStyle, character = e.model.characterStyle;
    const currentStyle = e.model.styles.definitions[character || current];
    const currentCount = currentStyle ? styleUsage(e.model).get(currentStyle.id) || 0 : 0;
    const list = styleList(e), ro = readOnly();
    const items = list.map(s => {
      const active = s.id === current || s.id === character;
      const look = showPreview ? preview(s.id) : {};
      const more = el('button.icon-btn.styles-pane-more', { type: 'button', 'aria-label': `${styleDisplayName(s.name)} options`, title: 'Style options', 'aria-haspopup': 'menu', onclick: e2 => { e2.stopPropagation(); menu(s, more); } }, iconEl('more', 16));
      const item = el('div.styles-pane-item', { role: 'option', 'aria-selected': String(active), dataset: { style: s.id } },
        el('button.styles-pane-apply', { type: 'button', disabled: ro, 'aria-label': `Apply ${styleDisplayName(s.name)} (${s.type === 'character' ? 'character' : 'paragraph'} style)`, title: `Apply ${styleDisplayName(s.name)}${s.count ? ` · used ${s.count} ${s.count === 1 ? 'time' : 'times'}` : ''}`, onclick: () => actions.apply(s.id),
          oncontextmenu: ev => { ev.preventDefault(); menu(s, more, ev); } },
        el('span.styles-pane-name', { style: look }, styleDisplayName(s.name)),
        el('span.styles-pane-kind', { 'aria-label': s.type === 'character' ? 'Character style' : 'Paragraph style', title: s.type === 'character' ? 'Character style' : 'Paragraph style' }, s.type === 'character' ? 'a' : '¶')), more);
      return item;
    });
    const filterSelect = el('select.input', { 'aria-label': 'List', onchange: () => { filter = filterSelect.value; store(FILTER_KEY, filter); signature = ''; refresh(); } },
      el('option', { value: 'recommended' }, 'Recommended'), el('option', { value: 'inUse' }, 'Styles in use'), el('option', { value: 'all' }, 'All styles'));
    filterSelect.value = filter;
    const previewBox = el('input', { type: 'checkbox', checked: showPreview, onchange: () => { showPreview = previewBox.checked; store(PREVIEW_KEY, showPreview ? '1' : '0'); signature = ''; refresh(); } });
    body.replaceChildren(
      el('div.styles-pane-current', {},
        el('span.field-label', {}, 'Current style of selected text'),
        el('strong.styles-pane-current-name', {}, currentStyle ? styleDisplayName(currentStyle.name) : current === null ? 'Mixed styles' : 'Default paragraph'),
        el('div.styles-pane-actions', {},
          el('button.btn.btn-outline.btn-sm', { type: 'button', disabled: !currentStyle || !currentCount, onclick: () => actions.selectAll(currentStyle.id) }, currentCount ? `Select All ${currentCount} Instance${currentCount === 1 ? '' : 's'}` : 'Select All Instances'),
          el('button.btn.btn-outline.btn-sm', { type: 'button', disabled: ro, onclick: () => actions.create() }, 'New Style…'),
          el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: ro, onclick: () => actions.clearFormatting() }, 'Clear Formatting'))),
      el('div.styles-pane-list', { role: 'listbox', 'aria-label': 'Apply a style' }, ...items, !items.length && el('p.field-hint', {}, 'No styles to show with this filter.')),
      el('div.styles-pane-footer', {}, el('label.ed-font-field', {}, el('span.field-label', {}, 'List'), filterSelect), el('label.ed-check', {}, previewBox, 'Show styles as they look'),
        el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => actions.manage() }, 'Manage Styles…')));
  }
  function menu(style, anchor, event) {
    const e = engine(); if (!e) return;
    const count = styleUsage(e.model).get(style.id) || 0, ro = readOnly();
    openMenu({ anchor, x: event?.clientX ?? null, y: event?.clientY ?? null, label: styleDisplayName(style.name), onClose: null, items: [
      { label: 'Apply', disabled: ro, onSelect: () => actions.apply(style.id) },
      { label: 'Modify…', icon: 'editStyle', disabled: ro, onSelect: () => actions.modify(style.id) },
      { label: `Select All ${count} Instance${count === 1 ? '' : 's'}`, disabled: !count, onSelect: () => actions.selectAll(style.id) },
      { label: 'Update to Match Selection', disabled: ro || style.type !== 'paragraph', onSelect: () => actions.updateToMatch(style.id) },
      { separator: true },
      { label: `Delete ${styleDisplayName(style.name)}…`, disabled: ro, onSelect: () => actions.remove(style.id) },
    ] });
  }

  function renderInspector(e) {
    const info = styleInspection(e.model), name = id => styleDisplayName(e.model.styles.definitions[id]?.name || id);
    const ro = readOnly();
    const section = (title, styleLabel, direct, clearStyleLabel, clearStyle, clearDirectLabel, clearDirect) => el('section.styles-inspector-section', {},
      el('h3', {}, title),
      el('div.styles-inspector-row', {}, el('span', {}, styleLabel), el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: ro, onclick: clearStyle }, clearStyleLabel)),
      el('div.styles-inspector-row', {}, el('span', { className: direct.length ? 'is-direct' : '' }, direct.length ? `Plus: ${describeKeys(direct)}` : 'No direct formatting'),
        el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: ro || !direct.length, onclick: clearDirect }, clearDirectLabel)));
    body.replaceChildren(
      section('Paragraph formatting', info.paragraphStyle ? name(info.paragraphStyle) : 'Default paragraph', info.directParagraph, 'Reset to Normal', () => actions.resetParagraphStyle(), 'Clear Paragraph Formatting', () => actions.clearParagraph()),
      section('Text level formatting', info.characterStyle ? name(info.characterStyle) : 'Default characters', info.directText, 'Clear Character Style', () => actions.clearCharacterStyle(), 'Clear Character Formatting', () => actions.clearText()),
      el('div.styles-pane-actions', {},
        el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => open('reveal') }, 'Reveal Formatting'),
        el('button.btn.btn-outline.btn-sm', { type: 'button', disabled: ro, onclick: () => actions.create() }, 'New Style…'),
        el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: ro, onclick: () => actions.clearFormatting() }, 'Clear All')));
  }

  let distinguish = true;
  function renderReveal(e) {
    const sections = revealFormatting(e.model, { styleName: id => styleDisplayName(e.model.styles.definitions[id]?.name || id) });
    const box = el('input', { type: 'checkbox', checked: distinguish, onchange: () => { distinguish = box.checked; signature = ''; refresh(); } });
    body.replaceChildren(
      el('p.styles-reveal-sample', {}, (() => { const [a, b] = e.model.range; const text = e.model.text.slice(a, b).replace(/\s+/g, ' ').trim(); return text ? `Selected text: “${text.slice(0, 60)}${text.length > 60 ? '…' : ''}”` : 'Formatting at the cursor'; })()),
      ...sections.map(({ title, entries }) => el('section.styles-reveal-section', { 'aria-label': title }, el('h3', {}, title),
        el('dl.styles-reveal-list', {}, ...entries.flatMap(item => [
          el('dt', {}, el('button.styles-reveal-link', { type: 'button', title: `Change ${item.label.toLowerCase()}`, onclick: () => actions.openTarget(item.target) }, item.label)),
          el('dd', { className: distinguish && item.direct ? 'is-direct' : '' }, item.value, distinguish && item.direct ? el('span.styles-reveal-badge', {}, 'direct') : null)])))),
      el('label.ed-check', {}, box, 'Distinguish direct formatting from styles'));
  }

  function refresh() {
    const e = engine();
    if (node.hidden || !e) return;
    const key = JSON.stringify([view, filter, showPreview, distinguish, e.session.revision, e.model.range, e.session.path, readOnly()]);
    if (key === signature) return;
    signature = key;
    // Every render replaces the view's controls. A keyboard user who just changed one (the list
    // filter, a check box, a Clear button) keeps focus on its replacement, or on the view's tab.
    const focused = body.contains(document.activeElement) ? controlKey(document.activeElement) : null;
    try {
      if (view === 'styles') renderStyles(e);
      else if (view === 'inspector') renderInspector(e);
      else renderReveal(e);
    } catch (error) { body.replaceChildren(el('p.field-error', {}, error.message)); }
    if (focused === null) return;
    const same = [...body.querySelectorAll('button, input, select')].find(control => !control.disabled && controlKey(control) === focused);
    (same || tabs.find(tab => tab.dataset.view === view)).focus();
  }
  /** What identifies a control across renders: its style row and its name. */
  const controlKey = control => [control.closest('.styles-pane-item')?.dataset.style, control.tagName, control.getAttribute('aria-label') || control.closest('label')?.textContent || control.textContent].join('|');
  return { node, open, close, refresh, get visible() { return !node.hidden; }, get view() { return view; } };
}
