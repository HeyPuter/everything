/**
 * Libraries feature: the Libraries panel and its store, plus dropping
 * library graphics onto the canvas.
 */
import './styles.css';
import { registerIcons } from '../../ui/icons.js';
import { LibraryStore } from './store.js';
import { LibrariesPanel, DRAG_TYPE, useItem } from './panel.js';

registerIcons({
  'panel-libraries': [['rect', { x: '3.5', y: '4', width: '4', height: '16', rx: '1' }], ['rect', { x: '9.5', y: '4', width: '4', height: '16', rx: '1' }], ['path', { d: 'm15.5 5.2 3.6-1 4 15.6-3.6 1z', 'stroke-linejoin': 'round' }]],
});

export function install(app) {
  app.libraries = new LibraryStore(app);
  app.registerPanel(LibrariesPanel);
  // Signing in or out switches where libraries are kept.
  app.on('user', () => app.libraries.load(true));
  // Edits wait briefly to be written together: write them before the page goes away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') app.libraries.flush(null, { hiding: true });
  });
  window.addEventListener('pagehide', () => app.libraries.flush(null, { hiding: true }));
  app.on('started', () => {
    const host = app.canvasHost;
    if (!host) return;
    host.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes(DRAG_TYPE)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    host.addEventListener('drop', (e) => {
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      if (!raw || !app.editor) return;
      e.preventDefault();
      try {
        const { lib, item } = JSON.parse(raw);
        const it = app.libraries.get(lib)?.items.find((x) => x.id === item);
        if (it) useItem(app, it, { point: app.eventToDoc(e) });
      } catch {
        // Not a library item.
      }
    });
  });
}
