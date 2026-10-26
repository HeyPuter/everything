/**
 * View → New Window: a second browser window showing the same document. The window that opened it
 * sends the document over a BroadcastChannel when this one is ready and again after each change, so
 * this copy follows the edits there. It is read-only: editing happens in the original window, which
 * keeps the one save handler. This page needs no account and stores nothing.
 */
import './styles/index.css';
import { el } from './ui/dom.js';
import { loadEngine } from './lib/engine.js';

const id = location.hash.slice(1);
const status = el('span.mirror-status', { role: 'status', 'aria-live': 'polite' }, 'Waiting for the document…');
const title = el('strong.mirror-title', {}, 'Documents');
const zoom = el('select', { 'aria-label': 'Zoom' }, ...[0.5, 0.75, 1, 1.25, 1.5].map(n => el('option', { value: n, selected: n === 1 }, `${n * 100}%`)));
const host = el('div.canvas-host', { 'aria-label': 'Document pages' });
const shell = el('main.canvas-workspace.ed-workspace.mirror-shell', {},
  el('header.mirror-bar', {}, title, el('span.mirror-note', {}, 'Second window · read only · edits in the original window appear here'), el('span.mirror-spacer'), status, el('label.mirror-zoom', {}, 'Zoom ', zoom)),
  el('div.canvas-document-surface', {}, host));
const style = el('style', {}, `
  .mirror-shell { display: flex; flex-direction: column; height: 100dvh; }
  .mirror-bar { display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 0 14px; border-bottom: 1px solid var(--ed-line, #e0e0e0); background: var(--ed-frame, #f3f3f3); font-size: 13px; flex-wrap: wrap; }
  .mirror-note { color: var(--ed-ink-3, #616161); }
  .mirror-spacer { flex: 1; }
  .mirror-status { color: var(--ed-ink-3, #616161); }
  .mirror-shell .canvas-document-surface { flex: 1; }
`);
document.head.append(style);
document.getElementById('app').replaceChildren(shell);

let editor = null, modules = null, version = 0;
zoom.addEventListener('change', () => editor?.setZoom(Number(zoom.value)));

async function show({ name, bytes }) {
  const mine = ++version;
  try { await render(mine, name, bytes); }
  // An update that a newer one has replaced says nothing about the document shown.
  catch (error) { if (mine === version) status.textContent = error?.message || 'The document could not be shown.'; }
}

async function render(mine, name, bytes) {
  modules ||= await loadEngine();
  const { CanvasEditor, openCanvasDocument, loadCanvasFonts } = modules;
  const { pkg, images, measure } = await openCanvasDocument(new Blob([bytes]));
  await loadCanvasFonts();
  if (mine !== version) { for (const image of images.values()) image.close?.(); return; }
  // Keep the reader's place across updates.
  const top = host.scrollTop, left = host.scrollLeft;
  editor?.destroy();
  editor = new CanvasEditor(host, { paragraphs: pkg.paragraphs, pageSettings: pkg.pageSettings, numbering: pkg.numbering, styles: pkg.styles, tables: pkg.tables, pageStories: pkg.pageStories,
    comments: pkg.comments, assets: pkg.assets, drawingLayouts: pkg.drawingLayouts, images, measure, readOnly: true, inputLabel: 'Document text (read only)' });
  editor.setZoom(Number(zoom.value));
  host.scrollTop = top; host.scrollLeft = left;
  title.textContent = name || 'Document';
  document.title = `${name || 'Document'} — second window`;
  status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

if (!id || typeof BroadcastChannel === 'undefined') status.textContent = 'Open this window from View → New Window.';
else {
  const channel = new BroadcastChannel(`documents-window:${id}`);
  channel.onmessage = e => {
    const message = e.data || {};
    if (message.type === 'document') show(message);
    else if (message.type === 'error') status.textContent = message.message;
    else if (message.type === 'closed') status.textContent = 'The original window was closed. This copy no longer updates.';
  };
  channel.postMessage({ type: 'ready' });
  addEventListener('pagehide', () => channel.postMessage({ type: 'closed' }));
}
