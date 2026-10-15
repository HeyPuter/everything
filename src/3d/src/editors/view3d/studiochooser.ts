// Shading popover rows that pick the studio light, MatCap or HDRI a viewport uses
// (the library is managed in Preferences ▸ Lights).
import { h, type Child } from '../../ui/h';
import { app } from '../../app/app';
import { enumMenu } from '../../ui/widgets';
import { renderContext } from '../../render/context';
import { library, findMatcap, findHdri, findStudio, matcapPreview, hdriPreview, onLibraryChange } from '../../render/studiolights';
import type { View3D } from './view3d';

const previews = new Map<string, string>();
// entries change (or user images finish loading): draw the previews again
onLibraryChange(() => previews.clear());
function cached(key: string, make: () => string) {
  let p = previews.get(key);
  if (!p) previews.set(key, (p = make()));
  return p;
}

/** Forget cached previews of a library entry (after it changed or was removed). */
export function dropStudioPreview(id: string) {
  for (const k of [...previews.keys()]) if (k.endsWith(`:${id}`)) previews.delete(k);
}

function set(v: View3D, key: 'studio_light' | 'studio_matcap' | 'studio_hdri', id: string) {
  v.shading[key] = id;
  renderContext?.forceSync();
  renderContext?.engine.requestDraw();
  app.changed('ui', 'view');
}

function grid(items: { id: string; name: string; src: string }[], cur: string, pick: (id: string) => void, cls: string): Child {
  return h(
    'div',
    { class: `studio-grid ${cls}` },
    items.map((it) =>
      h(
        'button',
        { key: it.id, class: { 'studio-cell': true, on: it.id === cur }, 'data-tip': it.name, 'aria-label': it.name, 'aria-pressed': it.id === cur ? 'true' : 'false', onclick: () => pick(it.id) },
        h('img', { src: it.src, alt: '', draggable: 'false' }),
      ),
    ),
  );
}

/** Rows for Solid shading: the studio light list or the MatCap grid. */
export function solidLightingChooser(v: View3D): Child {
  const sh = v.shading;
  if (sh.light === 'STUDIO')
    return enumMenu(
      'sh-studio',
      library.studio.map((s) => ({ value: s.id, label: s.name })),
      findStudio(sh.studio_light).id,
      (id) => set(v, 'studio_light', id),
      { tip: 'Studio Light\nLights fixed to the view (Preferences ▸ Lights edits them)' },
    );
  if (sh.light === 'MATCAP') {
    const cur = findMatcap(sh.studio_matcap).id;
    return grid(library.matcaps.map((m) => ({ id: m.id, name: m.name, src: cached(`m:${m.id}`, () => matcapPreview(m)) })), cur, (id) => set(v, 'studio_matcap', id), 'matcaps');
  }
  return null;
}

/** HDRI grid for Material Preview when the scene world is not used. */
export function hdriChooser(v: View3D): Child {
  const cur = findHdri(v.shading.studio_hdri).id;
  return grid(library.hdris.map((d) => ({ id: d.id, name: d.name, src: cached(`h:${d.id}`, () => hdriPreview(d)) })), cur, (id) => set(v, 'studio_hdri', id), 'hdris');
}
