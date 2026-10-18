/**
 * The Version History pane: the document's saved versions (lib/versions.js)
 * newest first, grouped by day, with who saved each and the name given to it.
 * A version opens read-only beside the document; it can be compared with the
 * current document (the Review tab's Compare), named, or restored.
 *
 * Restoring keeps the current document recoverable: a document edited
 * together restores as one undoable change everyone receives (body, tables,
 * styles, lists, page setup and comments); otherwise the saved file is
 * replaced exactly, after a recovery version of the current one is kept.
 */
import { el } from '../ui/dom.js';
import { confirmDialog, promptDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import * as P from '../lib/puter.js';
import { engineApi } from '../lib/engine-api.js';
import { listVersions, readVersionMeta, writeVersionMeta } from '../lib/versions.js';
import { sidePane, hint } from './review-ui.js';

const DAY = 86_400_000;
const dayLabel = (time, now = Date.now()) => {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return 'Today';
  if (time >= start.getTime() - DAY) return 'Yesterday';
  return new Date(time).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: new Date(time).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
};
const timeLabel = time => new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function createVersionHistory({ editor, pkg, doc, error, author, live = () => null, restoreFile, compare, onChange = () => {}, onPreview = () => {} }) {
  let versions = [], preview = null, loading = null;
  const pane = sidePane({ title: 'Version History', label: 'Version History pane', className: 'vh-pane', onOpen: () => load(), onClose: () => { closePreview(); editor()?.focus(); } });
  const list = el('div.vh-list', { role: 'list', 'aria-label': 'Saved versions' });
  const saveNow = el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => saveVersion() }, 'Save a Version Now');
  const status = el('p.vh-status', { role: 'status', 'aria-live': 'polite' });
  pane.body.append(el('div.vh-actions', {}, saveNow), status, list, hint('Versions are kept as you work: one every ten minutes of editing, and whenever you save one. The newest 30 are kept.'));

  /* ---- The read-only preview beside the document ---- */
  const previewHost = el('div.vh-preview-host', { 'aria-label': 'Version pages' });
  const previewTitle = el('h2.vh-preview-title', {}, 'Version');
  // The note is filled only while a version is shown, so a hidden pane never reads as the document's own "Read only" state.
  const previewNote = el('p.vh-preview-note');
  const previewNode = el('aside.vh-preview', { hidden: true, 'aria-label': 'Earlier version (read only)' },
    el('div.vh-preview-head', {}, el('div', {}, previewTitle, previewNote),
      el('div.vh-preview-actions', {},
        el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => preview && compareWith(preview.version) }, 'Compare'),
        el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => preview && restore(preview.version) }, 'Restore'),
        el('button.icon-btn', { type: 'button', 'aria-label': 'Close version', title: 'Close', onclick: () => closePreview() }, '×'))),
    previewHost);
  previewNode.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closePreview(); } });

  async function load() {
    status.textContent = '';
    if (!doc.path) { list.replaceChildren(el('p.rv-empty', {}, 'Versions are kept once the document is saved to Puter.')); saveNow.disabled = true; return; }
    saveNow.disabled = !!pkg()?.readOnly;
    list.replaceChildren(el('p.rv-status', {}, 'Loading versions…'));
    const request = loading = listVersions(doc.path).then(async found => Promise.all(found.map(async v => ({ ...v, ...await readVersionMeta(v) }))));
    try {
      const found = await request;
      if (loading !== request) return;
      versions = found;
      render();
    } catch { if (loading === request) list.replaceChildren(el('p.rv-status', {}, 'The version history could not be loaded.')); }
  }

  function render() {
    if (!versions.length) { list.replaceChildren(el('p.rv-empty', {}, 'No earlier versions yet.')); return; }
    const groups = new Map();
    for (const v of versions) { const label = dayLabel(v.time); if (!groups.has(label)) groups.set(label, []); groups.get(label).push(v); }
    list.replaceChildren(...[...groups].map(([label, items]) => el('section.vh-day', {}, el('h3.vh-day-label', {}, label), ...items.map(item))));
  }
  function item(v) {
    const shown = preview?.version.path === v.path;
    return el(`div.vh-item${shown ? '.is-open' : ''}`, { role: 'listitem' },
      el('button.vh-item-main', { type: 'button', 'aria-label': `${v.label || timeLabel(v.time)}${v.author ? `, saved by ${v.author}` : ''}. Open read-only.`, onclick: () => open(v) },
        el('span.vh-item-title', {}, v.label || timeLabel(v.time)),
        el('span.vh-item-meta', {}, [v.label ? timeLabel(v.time) : null, v.author ? `by ${v.author}` : null].filter(Boolean).join(' · ') || ' ')),
      el('div.vh-item-actions', {},
        el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => compareWith(v) }, 'Compare'),
        el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => nameVersion(v) }, v.label ? 'Rename' : 'Name'),
        el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: !!pkg()?.readOnly, onclick: () => restore(v) }, 'Restore')));
  }

  async function saveVersion() {
    saveNow.disabled = true;
    try {
      const label = await promptDialog({ title: 'Save a version', label: 'Name (optional)', placeholder: 'For example: Draft for review', confirmLabel: 'Save Version' });
      if (label === null) return;
      const v = await doc.saveVersionNow({ author: author(), label: label.trim() });
      if (!v) throw new Error('The version could not be saved.');
      toast(label.trim() ? `Saved “${label.trim()}”` : 'Version saved');
      await load();
    } catch (e) { error(e); }
    finally { saveNow.disabled = !doc.path || !!pkg()?.readOnly; }
  }

  async function nameVersion(v) {
    const label = await promptDialog({ title: v.label ? 'Rename version' : 'Name version', label: 'Name', value: v.label || '', confirmLabel: 'Save' });
    if (label === null) return;
    try { const meta = await writeVersionMeta(v, { author: v.author, label: label.trim() }); Object.assign(v, meta); render(); }
    catch (e) { error(e); }
  }

  const readBytes = async v => new Uint8Array(await (await P.readFile(v.path)).arrayBuffer());
  const versionName = v => v.label || `${dayLabel(v.time)} ${timeLabel(v.time)}`;

  async function open(v) {
    const api = engineApi(); if (!api) return;
    closePreview();
    previewTitle.textContent = versionName(v);
    previewNote.textContent = 'Read only';
    previewNode.hidden = false;
    previewHost.replaceChildren(el('p.rv-status', {}, 'Opening…'));
    const token = preview = { version: v, engine: null };
    onPreview(true);
    render(); onChange();
    try {
      const opened = await api.openCanvasDocument(await readBytes(v));
      if (preview !== token) { for (const image of opened.images.values()) image.close?.(); return; }
      const p = opened.pkg;
      previewHost.replaceChildren();
      token.engine = new api.CanvasEditor(previewHost, { paragraphs: p.paragraphs, pageSettings: p.pageSettings, numbering: p.numbering, styles: p.styles, tables: p.tables, pageStories: p.pageStories, comments: p.comments, assets: p.assets, drawingLayouts: p.drawingLayouts, images: opened.images, readOnly: true, inputLabel: `Version ${versionName(v)}` });
      fit(token.engine);
      token.pkg = p;
    } catch (e) {
      if (preview === token) previewHost.replaceChildren(el('p.rv-status', {}, `This version could not be opened: ${e.message}`));
    }
  }
  function fit(engine) {
    const page = engine.layout?.pages?.[0] || engine.layout?.page;
    if (!page?.width) return;
    const width = Math.max(200, previewHost.clientWidth - 32);
    engine.setZoom(Math.min(1, width / page.width));
  }
  function closePreview() {
    if (!preview) return;
    preview.engine?.destroy();
    preview = null;
    previewNode.hidden = true;
    previewNote.textContent = '';
    previewHost.replaceChildren();
    onPreview(false);
    render(); onChange();
  }

  function compareWith(v) {
    compare?.({ name: `Version: ${versionName(v)}`, read: () => readBytes(v) });
  }

  async function restore(v) {
    const engine = editor(); if (!engine || pkg()?.readOnly) return;
    const shared = !!live();
    const ok = await confirmDialog({ title: 'Restore this version?', danger: false, confirmLabel: 'Restore',
      message: shared ? `The document goes back to “${versionName(v)}” for everyone editing it. You can undo this.` : `The document goes back to “${versionName(v)}”. The current version is kept in the history.` });
    if (!ok) return false;
    try {
      if (!shared) { closePreview(); pane.close({ quiet: true }); await restoreFile(v); return; }
      const api = engineApi();
      const opened = preview?.version.path === v.path && preview.pkg ? { pkg: preview.pkg, images: null } : await api.openCanvasDocument(await readBytes(v));
      const p = opened.pkg;
      if (p.readOnly) throw new Error('This version uses features that can only be displayed, so it cannot be restored while others edit with you.');
      engine.finishComposition();
      if (engine.session.path !== null) engine.editStory(null);
      // One undoable change: the version's body, tables, styles, lists, page setup and comments.
      engine.execute(() => {
        const model = engine.model;
        Object.assign(model.assets, p.assets);
        const state = new (model.constructor)(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, model.assets, { comments: p.comments ?? model.comments, trackChanges: model.trackChanges });
        model.checkpoint?.();
        model.restore({ ...state.snapshot(), selection: { anchor: 0, focus: 0 } });
      });
      for (const [id, image] of opened.images || []) { if (!engine.images.has(id)) engine.images.set(id, image); else image.close?.(); }
      engine.relayout(); engine.paint();
      toast(`Restored “${versionName(v)}”`, { action: { label: 'Undo', onClick: () => engine.undo() } });
      closePreview();
      return true;
    } catch (e) { error(e); }
    return false;
  }

  return {
    pane, previewNode,
    open() { pane.open(); },
    toggle() { pane.toggle(); },
    /** Restore a version: through the room while the document is shared, else by replacing the file. */
    restore,
    get isOpen() { return pane.isOpen; },
    refresh() { if (preview?.engine) fit(preview.engine); },
    destroy() { closePreview(); pane.destroy(); },
  };
}
