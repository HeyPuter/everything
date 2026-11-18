import type { Editor } from '../editor';
import { registerCommand, type Command } from '../app/registry';
import type { LayoutKind } from '../app/view-layout';
import { cascade } from '../app/view-layout';
import { centerPoint, panToCenter } from '../app/view-transform';
import type { DocumentView } from '../app/views';
import { refreshViews } from './view-modes';

// Window → Arrange: tiled and n-up layouts, floating windows, matching views
// and extra windows onto the same document.

function arrange(e: Editor, kind: LayoutKind) {
  e.windows.setKind(kind);
  e.update();
}
/** Copy zoom, location and/or rotation from the active window to every other window. */
export function matchViews(e: Editor, what: { zoom?: boolean; location?: boolean; rotation?: boolean }) {
  const a = e.activeView;
  const [ax, ay] = centerPoint(a.state(e.viewAspect(a.session)), a.session.doc);
  const fx = ax / a.session.doc.width,
    fy = ay / a.session.doc.height;
  for (const v of e.views) {
    if (v === a) continue;
    const doc = v.session.doc;
    const state = () => v.state(e.viewAspect(v.session));
    // Matching location keeps the same relative point centered; otherwise each
    // window keeps its own center while zoom or rotation changes.
    const [cx, cy] = what.location ? [fx * doc.width, fy * doc.height] : centerPoint(state(), doc);
    if (what.zoom) v.zoom = a.zoom;
    if (what.rotation) {
      v.rotation = a.rotation;
      v.flip = a.flip;
    }
    v.pan = panToCenter(state(), doc, cx, cy);
  }
  refreshViews(e);
}

export function installWindows(e: Editor) {
  const many = (e: Editor) => e.views.length > 1;
  const layout = (id: string, label: string, kind: LayoutKind, description?: string): Command => ({
    id,
    label,
    recordable: false,
    enabled: many,
    checked: (e) => e.windows.kind === kind && many(e) && !e.views.some((v) => v.floating),
    run: (e) => arrange(e, kind),
    description,
  });
  registerCommand(
    layout('window.tile-vertical', 'Tile All Vertically', 'tile-vertical', 'Every window side by side'),
    layout('window.tile-horizontal', 'Tile All Horizontally', 'tile-horizontal', 'Every window stacked top to bottom'),
    layout('window.2up-horizontal', '2-up Horizontal', '2-up-horizontal', 'Two windows, one above the other'),
    layout('window.2up-vertical', '2-up Vertical', '2-up-vertical', 'Two windows side by side'),
    layout('window.3up-horizontal', '3-up Horizontal', '3-up-horizontal'),
    layout('window.3up-vertical', '3-up Vertical', '3-up-vertical'),
    layout('window.3up-stacked', '3-up Stacked', '3-up-stacked', 'One large window beside two stacked ones'),
    layout('window.4up', '4-up', '4-up'),
    layout('window.6up', '6-up', '6-up'),
    layout('window.tile-all', 'Tile', 'tile-grid', 'Every window in a grid'),
    {
      id: 'window.consolidate',
      label: 'Consolidate All to Tabs',
      recordable: false,
      enabled: (e) => e.windows.multi,
      run: (e) => {
        e.windows.consolidate();
        e.update();
      },
    },
    {
      id: 'window.cascade',
      label: 'Cascade',
      recordable: false,
      enabled: (e) => e.hasDocument,
      run: (e) => {
        // Float every window and restack them diagonally, active on top.
        const area = e.windows.areaSize();
        e.views.forEach((v: DocumentView, i: number) => (v.floating = cascade(i, area)));
        // The docked layout behind the windows goes back to tabs, also after a reload.
        e.windows.setKind('tabs');
        e.update();
      },
    },
    {
      id: 'window.float',
      label: 'Float in Window',
      recordable: false,
      enabled: (e) => e.hasDocument && !e.activeView.floating,
      run: (e) => {
        e.windows.float([e.activeView]);
        e.update();
      },
    },
    {
      id: 'window.float-all',
      label: 'Float All in Windows',
      recordable: false,
      enabled: (e) => e.hasDocument && e.views.some((v) => !v.floating),
      run: (e) => {
        e.windows.setKind('tabs');
        e.windows.float([...e.views].sort((a, b) => a.used - b.used));
        e.update();
      },
    },
    { id: 'window.match-zoom', label: 'Match Zoom', recordable: false, enabled: many, run: (e) => matchViews(e, { zoom: true }) },
    { id: 'window.match-location', label: 'Match Location', recordable: false, enabled: many, run: (e) => matchViews(e, { location: true }) },
    { id: 'window.match-rotation', label: 'Match Rotation', recordable: false, enabled: many, run: (e) => matchViews(e, { rotation: true }) },
    { id: 'window.match-all', label: 'Match All', recordable: false, enabled: many, run: (e) => matchViews(e, { zoom: true, location: true, rotation: true }) },
    {
      id: 'window.new-window',
      // The label names the active document.
      get label() {
        return `New Window for ${e.hasDocument ? e.doc.name : 'Document'}`;
      },
      recordable: false,
      enabled: (e) => e.hasDocument,
      description: 'Open a second window onto this document with its own zoom and position',
      run: async (e) => {
        const v = e.addView(e.session, e.activeView);
        if (e.activeView.floating) v.floating = cascade(e.views.filter((x) => x.floating).length, e.windows.areaSize());
        await e.activateView(v);
        e.windows.refresh();
        e.update();
      },
    },
  );
}
