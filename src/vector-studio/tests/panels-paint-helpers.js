// Shared setup for the paint panel tests (panels-paint-*.test.js).
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';

/** Boot the app with a new document; add(style, rect) adds a rectangle, panel(id) opens a panel, menuItem finds a panel menu entry. */
export async function paintSetup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const add = (style, rect = [0, 0, 10, 10]) => {
    const p = createPath(rectangle(...rect), true, style);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  const panel = (id) => {
    app.openPanel(id);
    const p = app.dock.panels.get(id);
    p.ensureBuilt();
    p.update();
    return p;
  };
  const menuItem = (p, label) => {
    const find = (spec) => {
      for (const it of spec) {
        if (it && typeof it === 'object' && it.label === label) return it;
        if (it?.submenu) {
          const r = find(it.submenu);
          if (r) return r;
        }
      }
      return null;
    };
    return find(p.menu());
  };
  return { app, ed, doc, add, panel, menuItem };
}
