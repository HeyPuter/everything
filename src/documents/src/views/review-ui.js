/**
 * Shared pieces for the Review panes: a side pane that docks beside the pages (one review pane
 * at a time), small section and button helpers, and language names.
 */
import { el, isComposing } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';

const panes = new Set();

/** A pane docked at the side of the document. Opening one review pane closes the others. */
export function sidePane({ title, label = title, className = '', onOpen, onClose }) {
  const heading = el('h2', {}, title);
  const body = el('div.canvas-panel-scroll.rv-pane-body');
  const node = el(`aside.canvas-outline-panel.ed-proof-pane.rv-pane${className ? `.${className}` : ''}`, { 'aria-label': label, hidden: true },
    el('div.canvas-panel-heading', {}, heading, el('button.icon-btn', { type: 'button', 'aria-label': `Close ${label}`, title: 'Close', onclick: () => pane.close() }, iconEl('x', 18))),
    body);
  node.addEventListener('keydown', e => { if (e.key === 'Escape' && !isComposing(e) && !e.defaultPrevented && !e.target.closest?.('[role="menu"]')) { e.preventDefault(); pane.close(); } });
  const pane = {
    node, body, heading,
    get isOpen() { return !node.hidden; },
    open({ focus = true } = {}) {
      for (const other of panes) if (other !== pane && other.isOpen) other.close({ quiet: true });
      const was = !node.hidden;
      node.hidden = false;
      if (!was) onOpen?.();
      if (focus) queueMicrotask(() => (node.querySelector('[autofocus], input, select, button:not(.icon-btn)') || node.querySelector('button'))?.focus({ preventScroll: true }));
    },
    close({ quiet = false } = {}) { if (node.hidden) return; node.hidden = true; onClose?.({ quiet }); },
    toggle() { if (pane.isOpen) pane.close(); else pane.open(); },
  };
  panes.add(pane);
  pane.destroy = () => panes.delete(pane);
  return pane;
}

/** A titled section in a pane. */
export const section = (title, ...children) => el('section.rv-section', {}, el('h3.rv-section-title', {}, title), ...children);
export const button = (label, onclick, { primary = false, small = true, ...attrs } = {}) => el(`button.btn${primary ? '.btn-primary' : '.btn-outline'}${small ? '.btn-sm' : ''}`, { type: 'button', onclick, ...attrs }, label);
export const hint = text => el('p.field-hint.rv-hint', {}, text);

/** Common proofing languages as BCP 47 tags, named in the reader's own language where the browser can. */
export const LANGUAGES = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'es-ES', 'es-MX', 'fr-FR', 'fr-CA', 'de-DE', 'de-CH', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'sv-SE', 'nb-NO', 'da-DK', 'fi-FI', 'pl-PL', 'cs-CZ', 'sk-SK', 'hu-HU', 'ro-RO', 'el-GR', 'tr-TR', 'ru-RU', 'uk-UA', 'he-IL', 'ar-SA', 'fa-IR', 'hi-IN', 'bn-IN', 'th-TH', 'vi-VN', 'id-ID', 'ms-MY', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR'];
let displayNames;
export function languageName(tag) {
  if (!tag) return 'No language set';
  try { displayNames ??= new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }); return displayNames.of(tag) || tag; } catch { return tag; }
}
/** Translation targets are named in English for the model. */
export function englishLanguageName(tag) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag; } catch { return tag; }
}

/** A stored preference with a fallback when storage is unavailable. */
export function preference(key, fallback) {
  return {
    get() { try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; } },
    set(value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } },
  };
}

/** Select a document range in the body and bring it into view. */
export function reveal(engine, start, end = start) {
  if (!engine) return;
  engine.finishComposition();
  if (engine.session.path !== null) engine.editStory(null);
  const length = engine.model.text.length;
  engine.model.select(Math.min(start, length), Math.min(end, length));
  engine.syncInput?.(); engine.paint(); engine.revealCaret?.(); engine.onSelection?.();
}
