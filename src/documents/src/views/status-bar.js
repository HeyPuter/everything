import { el, MOD_KEY, isComposing } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { openModal } from '../ui/modal.js';
import { commandIconEl } from '../ui/ribbon.js';
import { localStore } from '../lib/storage.js';
import { DOCUMENT_VIEWS } from './classic-menus.js';

const STORE = 'documents:statusbar';
/** Proofing languages offered by the language picker, as BCP 47 tags (w:lang values, §17.3.2.20). */
export const LANGUAGES = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'fr-FR', 'fr-CA', 'de-DE', 'es-ES', 'es-MX', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI',
  'pl-PL', 'cs-CZ', 'tr-TR', 'el-GR', 'ru-RU', 'uk-UA', 'ar-SA', 'he-IL', 'fa-IR', 'hi-IN', 'ja-JP', 'zh-CN', 'zh-TW', 'ko-KR'];

/** "English (United States)" for "en-US", in the user's language. */
export function languageName(tag, locale) {
  if (!tag) return 'No language';
  try { return new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'language', languageDisplay: 'standard' }).of(tag) || tag; } catch { return tag; }
}

export const STATUS_ITEMS = [
  ['page', 'Page Number'], ['words', 'Word Count'], ['proofing', 'Spelling Check'], ['language', 'Language'], ['accessibility', 'Accessibility Checker'], ['track', 'Track Changes'],
  ['area', 'Editing Area'], ['textMode', 'Text Mode'], ['focus', 'Focus'], ['views', 'View Shortcuts'], ['zoomSlider', 'Zoom Slider'], ['zoom', 'Zoom'],
];
const HIDDEN_BY_DEFAULT = ['track'];

function readHidden() {
  try { const value = JSON.parse(localStore()?.getItem(STORE) || 'null'); return Array.isArray(value) ? value : HIDDEN_BY_DEFAULT; } catch { return HIDDEN_BY_DEFAULT; }
}

/**
 * The status bar: page and word counts (each opens its dialog), spelling, the language of the
 * selection, Track Changes, the editing area, and on the right Text mode, Focus, the views and the zoom.
 * Right-click it to choose what it shows; the choice is remembered on this device.
 */
export function createStatusBar({ w, a, parts, help }) {
  const { stats, words, proofingButton, editingArea, textMode, focusButton, zoomOut, zoomSlider, zoomIn, zoomLabel } = parts;
  stats.className = ''; // its button carries the status-item look
  const pageButton = el('button.ed-status-item.ed-page-count', { type: 'button', title: `Go To (${MOD_KEY === 'Cmd' ? 'Cmd+Option+G' : 'Ctrl+G'})`, onclick: () => (w.goTo ? w.goTo() : a.toggleNavigation?.()) }, stats);
  const wordsButton = el('button.ed-status-item.ed-word-count', { type: 'button', title: 'Word Count', onclick: () => w.wordCount?.() }, words);
  const languageLabel = el('span', {}, languageName('en-US'));
  const language = el('button.ed-status-item.ed-status-language', { type: 'button', title: 'Language', 'aria-haspopup': 'dialog', onclick: () => openLanguageDialog() }, languageLabel);
  const accessibilityLabel = el('span', {}, 'Accessibility');
  const accessibility = w.accessibilitySummary ? el('button.ed-status-item.ed-status-accessibility', { type: 'button', title: 'Check Accessibility',
    onclick: () => (w.accessibilitySummary()?.open ? w.accessibilitySummary().open() : w.checkAccessibility?.()) }, commandIconEl('accessibility', 14), accessibilityLabel) : null;
  const trackLabel = el('span', {}, 'Track Changes: Off');
  const track = w.toggleTracking ? el('button.ed-status-item.ed-status-track', { type: 'button', title: `Track Changes (${MOD_KEY}+Shift+E)`, onclick: () => w.toggleTracking() }, commandIconEl('trackChanges', 14), trackLabel) : null;
  const views = el('div.ed-status-views', { role: 'group', 'aria-label': 'Views' });
  let viewSignature = '';
  function renderViews() {
    const modes = w.documentViewModes?.() || ['print'];
    const current = w.documentView?.() || 'print';
    const signature = JSON.stringify([modes, current]);
    if (signature === viewSignature) return;
    viewSignature = signature;
    views.replaceChildren(...DOCUMENT_VIEWS.filter(([mode]) => mode === 'print' || modes.includes(mode)).map(([mode, label, icon]) => {
      const button = el('button.icon-btn.ed-status-view', { type: 'button', 'aria-label': label, title: label, 'aria-pressed': String(current === mode),
        onclick: () => (w.setDocumentView ? w.setDocumentView(mode) : a.focusEditor?.()) }, commandIconEl(mode === 'print' ? 'printLayoutSolid' : icon, 16));
      return button;
    }));
  }
  const items = {
    page: pageButton, words: wordsButton, proofing: proofingButton, language, accessibility, track, area: editingArea,
    textMode, focus: focusButton, views, zoomSlider: el('div.ed-zoom-slider-wrap', {}, zoomOut, zoomSlider, zoomIn), zoom: zoomLabel,
  };
  for (const [id, node] of Object.entries(items)) node?.setAttribute('data-status-item', id);
  let hidden = new Set(readHidden());
  const left = el('div.ed-status-left', {}, ...['page', 'words', 'proofing', 'language', 'accessibility', 'track', 'area'].map(id => items[id]).filter(Boolean));
  const right = el('div.ed-status-right', {}, items.textMode, items.focus, items.views, el('div.ed-zoom', {}, items.zoomSlider, items.zoom));
  const footer = el('footer.canvas-statusbar.ed-statusbar', { 'aria-label': 'Status bar' }, left, right, help);
  footer.addEventListener('contextmenu', e => {
    if (e.target.closest('input, select')) return;
    e.preventDefault();
    openMenu({ anchor: footer, x: e.clientX, y: e.clientY, label: 'Customize Status Bar', minWidth: 230, pointer: true, items: [
      { header: 'Show in the status bar' },
      ...STATUS_ITEMS.filter(([id]) => items[id]).map(([id, label]) => ({ label, checked: !hidden.has(id), onSelect: () => toggle(id) })),
    ] });
  });
  function toggle(id) {
    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    try { localStore()?.setItem(STORE, JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
    apply();
  }
  // Track Changes shows itself while tracking is on; choosing it in the menu keeps it shown when off too.
  function apply() { for (const [id, node] of Object.entries(items)) if (node) node.classList.toggle('is-user-hidden', hidden.has(id) && !(id === 'track' && w.isTracking?.())); }
  apply();

  /** The proofing language for the selection (w:lang); with the engine's support it is written to the document. */
  function openLanguageDialog() {
    const current = w.currentLanguage?.() ?? 'en-US';
    const list = el('div.ed-choice-list.ed-language-list', { role: 'listbox', 'aria-label': 'Languages' });
    const filter = el('input.input', { type: 'search', placeholder: 'Search languages', 'aria-label': 'Search languages' });
    const noProof = el('input', { type: 'checkbox', checked: !!w.noProofing?.() });
    const tags = [...new Set([current, ...LANGUAGES].filter(Boolean))];
    let chosen = current;
    // The list is one Tab stop, on the chosen language; Up, Down, Home and End move the choice.
    const options = () => [...list.querySelectorAll('[role="option"]')];
    const mark = () => {
      const all = options(), stop = all.find(o => o.dataset.tag === chosen) || all[0];
      for (const o of all) { o.setAttribute('aria-selected', String(o.dataset.tag === chosen)); o.tabIndex = o === stop ? 0 : -1; }
      return stop;
    };
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      list.replaceChildren(...tags.filter(tag => !q || languageName(tag).toLowerCase().includes(q) || tag.toLowerCase().includes(q)).map(tag => el('button.ed-choice', { type: 'button', role: 'option', dataset: { tag },
        onclick: () => { chosen = tag; mark(); }, ondblclick: () => apply() }, languageName(tag), el('span.ed-choice-hint', {}, tag))));
      mark();
    };
    list.addEventListener('keydown', e => {
      if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
      const all = options(), at = all.indexOf(document.activeElement);
      const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
      if (next === undefined || at < 0) return;
      e.preventDefault();
      const option = all[Math.max(0, Math.min(all.length - 1, next))];
      option.click(); option.focus();
    });
    filter.addEventListener('input', render);
    filter.addEventListener('keydown', e => { if (e.key === 'ArrowDown' && !isComposing(e)) { e.preventDefault(); mark()?.focus(); } });
    const editable = !!w.setLanguage && !!a.hasDocument?.() && !w.documentReadOnly?.();
    const apply = () => { modal.close(); w.setLanguage?.(chosen, { noProof: noProof.checked }); };
    const modal = openModal({ title: 'Language', onClose: () => queueMicrotask(() => a.focusEditor?.()), content: el('form.ed-dialog-body', { onsubmit: e => { e.preventDefault(); if (editable) apply(); else modal.close(); } },
      el('p.field-hint', {}, editable ? 'Mark the selected text as:' : 'The language of the text at the cursor:'), filter, list,
      el('label.ed-check', {}, noProof, 'Do not check spelling or grammar'),
      el('p.field-hint', {}, 'Spelling checks English text. Other languages are marked in the document so other editors check them with their dictionaries.'),
      el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit', disabled: !editable }, 'OK'))) });
    noProof.disabled = !editable;
    render();
    filter.focus();
  }

  function refresh() {
    if (accessibility) {
      const summary = a.hasDocument?.() ? w.accessibilitySummary() : null;
      const label = summary?.label || 'Accessibility: check';
      if (accessibilityLabel.textContent !== label) { accessibilityLabel.textContent = label; accessibility.title = summary ? `${label}. Open the Accessibility pane.` : 'Check Accessibility'; }
      accessibility.dataset.state = !summary ? 'unchecked' : summary.errors ? 'errors' : summary.warnings || summary.tips ? 'warnings' : 'clean';
      accessibility.disabled = !a.hasDocument?.();
    }
    const tag = w.currentLanguage?.();
    const name = tag === null ? 'Mixed languages' : languageName(tag || 'en-US');
    if (languageLabel.textContent !== name) { languageLabel.textContent = name; language.title = `Language: ${name}`; }
    if (track) { const on = !!w.isTracking?.(); trackLabel.textContent = `Track Changes: ${on ? 'On' : 'Off'}`; track.setAttribute('aria-pressed', String(on)); track.disabled = !w.canTrack?.(); apply(); }
    pageButton.disabled = wordsButton.disabled = !a.hasDocument?.();
    renderViews();
  }
  return { el: footer, refresh, openLanguageDialog, isShown: id => !hidden.has(id), toggle };
}
