// File → Generate → Image Assets: layers and groups named like files
// ("icon.png", "200% hero.jpg80, thumbs/hero.webp") are written as image
// files after edits while the per-document toggle is on — into a folder next
// to the document on Puter, or kept for File → Generate → Download Image
// Assets (.zip). Registration and the status indicator live here; planning
// is small and pure (plan.ts), rendering and encoding load on first use.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { registerCommand } from '../../app/registry';
import { lazy, lazyRun } from '../../app/lazy';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { hasAssetNames } from './plan';
import { assetListeners, assetState, peekAssetState, statusText } from './state';
import './image-assets.css';

const impl = lazy(() => import('./generate'));
// Edits settle for this long before assets are generated again.
export const ASSET_DELAY_MS = 1200;

const named = new WeakMap<PhotoDocument, boolean>();
/** Whether the document has asset-named layers (cached per state). */
export function documentHasAssets(doc: PhotoDocument) {
  let v = named.get(doc);
  if (v === undefined) named.set(doc, (v = hasAssetNames(doc)));
  return v;
}

const timers = new WeakMap<DocumentSession, number>();
// The document state assets were last scheduled for, per open document.
const lastDoc = new WeakMap<DocumentSession, PhotoDocument>();
/** Generate the session's assets after `delay` ms (restarted by newer edits). */
export function scheduleAssets(e: Editor, s: DocumentSession, delay = ASSET_DELAY_MS) {
  clearTimeout(timers.get(s));
  // A newer edit cancels a generation in progress.
  const st = peekAssetState(s);
  if (st?.status === 'working') st.token++;
  timers.set(
    s,
    window.setTimeout(() => {
      timers.delete(s);
      if (!e.sessions.includes(s) || !s.hasDocument || !s.doc.imageAssets) return;
      // Readbacks share the compositor: wait for commands and gestures to end.
      if (e.session !== s) {
        // Picked up again when the document is active (see onUpdate).
        lastDoc.delete(s);
        return;
      }
      if (e.busy || e.toolBusy) return scheduleAssets(e, s, delay);
      void impl().then(
        (m) => m.generateAssets(e, s, { background: true, reschedule: () => scheduleAssets(e, s, delay) }),
        (error) => {
          const st = assetState(s);
          st.status = 'error';
          st.error = error instanceof Error ? error.message : String(error);
          assetListeners.forEach((f) => f());
        },
      );
    }, delay),
  );
}

export function installImageAssets(e: Editor) {
  registerCommand(
    {
      id: 'file.image-assets',
      label: 'Image Assets',
      description: 'Write layers named like files (icon.png, 200% hero.jpg) as image files whenever the document changes',
      recordable: false,
      enabled: (e) => e.hasDocument,
      checked: (e) => e.hasDocument && !!e.doc.imageAssets,
      run: (e) => {
        const on = !e.doc.imageAssets;
        e.command(on ? 'Image Assets On' : 'Image Assets Off', (d) => {
          if (on) d.imageAssets = true;
          else delete d.imageAssets;
        });
        if (on) {
          if (!documentHasAssets(e.doc)) e.message('Image Assets is on. Name a layer like a file (for example “icon.png” or “200% hero.jpg80”) to write it as an image.');
          scheduleAssets(e, e.session, 0);
        }
      },
    },
    {
      id: 'file.download-image-assets',
      label: 'Download Image Assets (.zip)',
      description: 'Generate the files that layer names ask for and download them as a ZIP',
      recordable: false,
      enabled: (e) => e.hasDocument && documentHasAssets(e.doc),
      ...lazyRun(impl, (m, e) => m.downloadAssets(e)),
    },
  );

  // Status bar indicator while the toggle is on.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'status-info image-assets-status';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.title = 'Image Assets: show the generated files and problems';
  button.hidden = true;
  const anchor = e.root.querySelector('#doc-info') ?? e.root.querySelector('.canvas-color-mode');
  anchor?.after(button);
  let shown = '';
  const render = () => {
    const on = e.hasDocument && !!e.doc.imageAssets;
    button.hidden = !on;
    if (!on) return;
    const st = peekAssetState(e.session);
    const text = statusText(st);
    const problems = !!st && (st.issues.length > 0 || !!st.error);
    const key = `${text}|${problems}`;
    if (key === shown) return;
    shown = key;
    button.classList.toggle('has-problems', problems);
    button.setAttribute('aria-label', `Image Assets: ${text.replace(/^Assets: /, '')}`);
    button.innerHTML = `${svg('image-assets', 13)}<span>${escapeXML(text)}</span>`;
  };
  assetListeners.push(render);
  button.addEventListener('click', () => void impl().then((m) => m.togglePopover(e, button)));
  button.addEventListener('pointerenter', () => impl.prefetch());

  e.onUpdate((e) => {
    render();
    if (!e.hasDocument || !e.doc.imageAssets) return;
    const s = e.session;
    if (lastDoc.get(s) === e.doc) return;
    lastDoc.set(s, e.doc);
    scheduleAssets(e, s);
  });
  // Saving gives a Puter location: write the files there right away.
  e.saveHooks.push((s) => {
    if (s.hasDocument && s.doc.imageAssets) scheduleAssets(e, s, 0);
  });
}
