import type { Editor } from '../editor';
import { registerCommand, registerTool, contributeMenu } from '../app/registry';
import { strokeTool } from './paint';
import { findLayer, replaceDocument, type PhotoDocument } from '../model/document';
import { TILE, tileKey } from '../model/tiles';
import type { PixelTarget } from './pixels';
import type { PaintTarget } from '../engine/paint';
import { formDialog } from '../ui/dialog';
import type { DocumentSession } from '../app/session';

// Snapshots keep a document state available independent of the undo stack;
// the History Brush paints pixels back from the chosen source state.
export type Snapshot = { id: string; name: string; doc: PhotoDocument };
const snapshots = new WeakMap<DocumentSession, Snapshot[]>();
const sources = new WeakMap<DocumentSession, string>();
export const historySourceId = (e: Editor) => sources.get(e.session);
export function sessionSnapshots(e: Editor, s: DocumentSession = e.session) {
  let list = snapshots.get(s);
  if (!list) {
    const created: Snapshot[] = [];
    snapshots.set(s, created);
    // Snapshot states keep their tiles when history no longer holds them.
    s.retained.push(() => created.map((x) => x.doc));
    list = created;
  }
  return list;
}
/** Source state for the History Brush: a snapshot, or the opened state
 * (also once history has dropped the steps after it). */
export function historySourceDoc(e: Editor): PhotoDocument {
  const id = historySourceId(e);
  const snap = sessionSnapshots(e).find((s) => s.id === id);
  if (snap) return snap.doc;
  return e.history.opened;
}
function historyTarget(e: Editor, target: PixelTarget): PaintTarget | undefined {
  if (target.kind !== 'pixels') {
    e.message('The History Brush paints on pixel layers.');
    return;
  }
  const src = findLayer(historySourceDoc(e).layers, target.layer.id);
  if (!src?.pixels) {
    e.message('Could not use the history brush because the history state does not contain a corresponding layer.');
    return;
  }
  const grid = src.pixels;
  const store = e.assets.tiles;
  return {
    kind: 'color',
    rgb: [0, 0, 0],
    mode: 'normal',
    source: (x, y, out) => {
      const lx = x - grid.x,
        ly = y - grid.y;
      const id = grid.tiles[tileKey(Math.floor(lx / TILE), Math.floor(ly / TILE))];
      if (!id) {
        out[0] = out[1] = out[2] = out[3] = 0;
        return true;
      }
      const d = store.get(id),
        i = ((((ly % TILE) + TILE) % TILE) * TILE + (((lx % TILE) + TILE) % TILE)) * 4;
      out[0] = d[i];
      out[1] = d[i + 1];
      out[2] = d[i + 2];
      out[3] = d[i + 3];
      return true;
    },
  };
}

export function installHistoryTools(e: Editor) {
  registerTool(strokeTool('history-brush', 'History Brush Tool', 'history-brush', 'history-brush', 'Y', 'History Brush', {}, historyTarget));
  registerCommand(
    {
      id: 'history.snapshot',
      label: 'New Snapshot…',
      recordable: false,
      enabled: (e) => e.hasDocument,
      run: async (e) => {
        const list = sessionSnapshots(e);
        const v = await formDialog('New Snapshot', [{ name: 'name', label: 'Name', value: `Snapshot ${list.length + 1}` }], 'OK');
        if (!v) return;
        list.push({ id: crypto.randomUUID(), name: v.name, doc: e.doc });
        e.dock.update();
      },
    },
    {
      id: 'history.restore-snapshot',
      label: 'Revert to Snapshot',
      hidden: true,
      run: (e, arg) => {
        const snap = sessionSnapshots(e).find((s) => s.id === arg);
        if (!snap) return;
        e.command(`Revert to ${snap.name}`, (d) => replaceDocument(d, snap.doc));
      },
    },
    {
      id: 'history.set-source',
      label: 'Set History Brush Source',
      hidden: true,
      run: (e, arg) => {
        if (arg) sources.set(e.session, String(arg));
        else sources.delete(e.session);
        e.dock.update();
      },
    },
  );
  contributeMenu('edit', ['history.snapshot'], 'edit.fade');
  // Preferences → History → Automatically create first snapshot: each opened
  // or new document gets a snapshot of the state it opened in.
  const seen = new WeakSet<DocumentSession>();
  e.onUpdate((e) => {
    for (const s of e.sessions) {
      if (!s.hasDocument || seen.has(s)) continue;
      seen.add(s);
      if (!e.preferences.autoSnapshot) continue;
      const list = sessionSnapshots(e, s);
      if (!list.length) list.push({ id: crypto.randomUUID(), name: s.doc.name, doc: s.history.oldest });
    }
  });
}
