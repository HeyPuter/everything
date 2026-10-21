// Brush shelf: a strip along the bottom of the 3D viewport in sculpt / paint modes with a
// thumbnail per brush, category tabs, a search field and a thumbnail size option. Space opens the
// same thumbnails as a popup at the pointer.
import { app, registerOperators } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys } from '../app/keymap';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { closeMenus, openMenu, openPopover } from '../ui/menu';
import { viewMenuExtras, viewportUIHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { BRUSH_LISTS, isBrushMode, type BrushInfo, type BrushMode } from './brushes';
import { brushThumb } from './brushthumbs';

/** Category names of the brush groups (separated by gaps in the toolbar lists). */
const GROUPS: Record<BrushMode, string[]> = {
  SCULPT: ['Add/Subtract', 'Contrast & Smooth', 'Transform', 'Simplify', 'Utilities', 'Paint'],
  VERTEX_PAINT: ['Paint'],
  WEIGHT_PAINT: ['Paint'],
  TEXTURE_PAINT: ['Paint'],
};

function categories(mode: BrushMode): { name: string; brushes: BrushInfo[] }[] {
  const out: { name: string; brushes: BrushInfo[] }[] = [];
  let cur: BrushInfo[] = [];
  const flush = () => {
    if (cur.length) out.push({ name: GROUPS[mode][out.length] ?? `Group ${out.length + 1}`, brushes: cur });
    cur = [];
  };
  for (const b of BRUSH_LISTS[mode]) {
    if (!b) flush();
    else cur.push(b);
  }
  flush();
  for (const f of shelfCategoryHooks) out.push(...f(mode));
  return out;
}

/** Extra shelf categories (e.g. brush assets of asset libraries). */
export const shelfCategoryHooks: ((mode: BrushMode) => { name: string; brushes: BrushInfo[] }[])[] = [];

interface ShelfState {
  show: boolean;
  tab: string;
  search: string;
  size: number;
}
const states = new WeakMap<View3D, ShelfState>();
function stateOf(v: View3D): ShelfState {
  let s = states.get(v);
  if (!s) states.set(v, (s = { show: true, tab: 'All', search: '', size: 56 }));
  return s;
}

const changed = () => app.changed('ui');

function tiles(mode: BrushMode, list: BrushInfo[], size: number, onPick?: () => void): Child {
  const cur = activeTools[mode];
  return list.map((b) =>
    h(
      'button',
      {
        key: b.id,
        class: { 'ps-tile': true, on: cur === b.id },
        'data-brush': b.id,
        'data-tip': `${b.name}${b.shortcut ? `\nShortcut: ${b.shortcut}` : ''}\n${b.description}`,
        style: { width: `${size + 8}px` },
        onclick: () => {
          if (b.pick) b.pick();
          else app.run('paint.brush_select', { brush: b.id });
          onPick?.();
        },
      },
      h('img', { src: brushThumb(b.tool, mode, size * 2), width: size, height: size, draggable: false, alt: '' }),
      size >= 48 ? h('span', { class: 'ps-name' }, b.name) : null,
    ),
  );
}

function filtered(mode: BrushMode, st: { tab: string; search: string }) {
  const cats = categories(mode);
  const q = st.search.trim().toLowerCase();
  let list = st.tab === 'All' ? cats.flatMap((c) => c.brushes) : (cats.find((c) => c.name === st.tab)?.brushes ?? []);
  if (q) list = list.filter((b) => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q));
  return { cats, list };
}

function shelf(v: View3D): Child {
  const mode = app.doc.mode;
  if (!isBrushMode(mode)) return null;
  const st = stateOf(v);
  if (!st.show) return null;
  const { cats, list } = filtered(mode, st);
  const left = v.showToolbar ? 50 : 4;
  const right = v.showSidebar ? 274 : 4;
  return h(
    'div',
    { key: 'paint-shelf', class: 'paint-shelf', style: { left: `${left}px`, right: `${right}px` } },
    h(
      'div',
      { class: 'ps-bar' },
      ['All', ...cats.map((c) => c.name)].map((t) => h('button', { key: t, class: { 'ps-tab': true, on: st.tab === t }, onclick: () => ((st.tab = t), changed()) }, t)),
      h('div', { class: 'ps-spacer' }),
      h('input', {
        class: 'ps-search',
        placeholder: 'Search',
        value: st.search,
        oninput: (e: Event) => ((st.search = (e.target as HTMLInputElement).value), changed()),
        onkeydown: (e: KeyboardEvent) => e.stopPropagation(),
      }),
      h(
        'button',
        {
          class: 'ps-icon',
          'data-tip': 'Display Size',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              [
                ['Small', 40],
                ['Medium', 56],
                ['Large', 80],
              ].map(([label, size]) => ({ label: label as string, active: st.size === size, action: () => ((st.size = size as number), changed()) })),
              e.currentTarget as HTMLElement,
              { title: 'Display Size' },
            );
          },
        },
        icon('preferences'),
      ),
      h('button', { class: 'ps-icon', 'data-tip': 'Hide the brush shelf (View ▸ Asset Shelf)', onclick: () => ((st.show = false), changed()) }, icon('x')),
    ),
    h('div', { class: 'ps-row' }, list.length ? tiles(mode, list, st.size) : h('div', { class: 'ps-empty' }, 'No brushes match')),
  );
}

viewportUIHooks.push(shelf);

registerOperators([
  {
    idname: 'view3d.toggle_asset_shelf',
    label: 'Asset Shelf',
    description: 'Show or hide the brush shelf at the bottom of the viewport',
    undo: false,
    poll: () => isBrushMode(app.doc.mode) && !!activeView3D(),
    exec: () => {
      const st = stateOf(activeView3D()!);
      st.show = !st.show;
      changed();
    },
  },
]);

viewMenuExtras.push(() => {
  const v = activeView3D();
  if (!v || !isBrushMode(app.doc.mode)) return [];
  return [{ label: 'Asset Shelf', op: 'view3d.toggle_asset_shelf', checked: stateOf(v).show }];
});

/** Space: the brushes as a popup grid at the pointer. */
function shelfPopup() {
  openBrushPicker({ x: app.pointer.x, y: app.pointer.y });
  return [];
}

/** Popup grid of the brushes of the current mode (Space, tool header brush button). */
export function openBrushPicker(anchor: HTMLElement | { x: number; y: number }) {
  const mode = app.doc.mode;
  if (!isBrushMode(mode)) return;
  const pst = { tab: 'All', search: '' };
  const pop = openPopover(
    anchor,
    () => {
      const { cats, list } = filtered(mode, pst);
      return h(
        'div',
        { class: 'pop-panel paint-shelf-pop' },
        h(
          'div',
          { class: 'ps-bar' },
          ['All', ...cats.map((c) => c.name)].map((t) => h('button', { key: t, class: { 'ps-tab': true, on: pst.tab === t }, onclick: () => ((pst.tab = t), pop.redraw()) }, t)),
        ),
        h('div', { class: 'ps-grid' }, tiles(mode, list, 56, () => closeMenus())),
      );
    },
    { width: 420 },
  );
}

for (const km of ['Sculpt', 'Vertex Paint', 'Weight Paint', 'Image Paint']) addKeys(km, [{ key: 'SPACE', menu: shelfPopup, menuTitle: 'Brushes', when: () => isBrushMode(app.doc.mode) }]);

// styles (scoped to the shelf)
if (typeof document !== 'undefined' && !document.getElementById('paint-shelf-style')) {
  const style = document.createElement('style');
  style.id = 'paint-shelf-style';
  style.textContent = `
.paint-shelf { position: absolute; bottom: 4px; display: flex; flex-direction: column; background: rgba(37, 38, 39,0.92); border: 1px solid rgba(0, 0, 0,0.5); border-radius: 6px; overflow: hidden; }
.paint-shelf .ps-bar, .paint-shelf-pop .ps-bar { display: flex; align-items: center; gap: 2px; padding: 3px 4px; border-bottom: 1px solid rgba(0, 0, 0,0.35); }
.ps-tab { background: none; border: none; color: var(--text-dim, #aaabad); padding: 2px 8px; border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer; }
.ps-tab:hover { color: var(--text, #dedfe1); background: rgba(255, 255, 255,0.06); }
.ps-tab.on { color: var(--text, #f0f1f2); background: rgba(255, 255, 255,0.12); }
.ps-spacer { flex: 1; }
.ps-search { width: 120px; background: rgba(0, 0, 0,0.35); border: 1px solid rgba(0, 0, 0,0.4); border-radius: 4px; color: var(--text, #dedfe1); font: inherit; font-size: 11px; padding: 2px 6px; }
.ps-icon { background: none; border: none; color: var(--text-dim, #aaabad); padding: 2px; cursor: pointer; display: flex; }
.ps-row { display: flex; gap: 4px; padding: 4px; overflow-x: auto; }
.ps-grid { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; max-height: 320px; overflow-y: auto; }
.ps-tile { flex: none; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; background: rgba(0, 0, 0,0.2); border: 1px solid transparent; border-radius: 5px; color: var(--text-dim, #bbbcbe); font: inherit; font-size: 10px; cursor: pointer; }
.ps-tile:hover { background: rgba(255, 255, 255,0.08); }
.ps-tile.on { border-color: var(--accent, #4b70b5); background: rgba(75, 112, 181,0.25); color: var(--text, #f0f1f2); }
.ps-tile img { display: block; pointer-events: none; }
.ps-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ps-empty { color: var(--text-dim, #999a9b); font-size: 11px; padding: 8px; }
.paint-brush-tile { display: flex; gap: 8px; align-items: flex-start; }
.paint-brush-tile img { flex: none; border-radius: 6px; background: rgba(0, 0, 0,0.25); }
.pbt-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.pbt-name { font-weight: 600; }
.pbt-desc { font-size: 11px; color: var(--text-dim, #999a9b); line-height: 1.3; }
.paint-pressure-row { display: flex; align-items: center; gap: 2px; }
.paint-pressure-row > :first-child { flex: 1; min-width: 0; }
.pressure-toggle { flex: none; }
.paint-color-picker .pcp-top { display: flex; gap: 8px; justify-content: center; padding: 4px 0; }
.pcp-wheel { position: relative; }
.pcp-wheel canvas { display: block; cursor: crosshair; }
.pcp-cursor { position: absolute; width: 8px; height: 8px; margin: -5px 0 0 -5px; border: 1px solid #ffffff; border-radius: 50%; box-shadow: 0 0 0 1px #000000; pointer-events: none; }
.pcp-value { position: relative; width: 16px; border-radius: 3px; cursor: ns-resize; }
.pcp-vcursor { position: absolute; left: -2px; right: -2px; height: 3px; margin-top: -2px; border: 1px solid #ffffff; box-shadow: 0 0 0 1px #000000; pointer-events: none; }
.paint-palette { display: flex; flex-wrap: wrap; gap: 3px; }
.pp-swatch, .pp-add { width: 22px; height: 22px; border-radius: 4px; border: 1px solid rgba(0, 0, 0,0.5); cursor: pointer; padding: 0; }
.pp-swatch.on { outline: 2px solid #ffffff; outline-offset: -1px; }
.pbt-head { display: flex; align-items: center; gap: 4px; }
.pbt-head .pbt-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pbt-menu { width: 22px; height: 20px; display: flex; align-items: center; justify-content: center; padding: 0; background: none; border: 1px solid transparent; border-radius: 4px; color: var(--text, #dedfe1); cursor: pointer; }
.pbt-menu:hover { background: rgba(255, 255, 255,0.08); }
.pp-wrap { display: flex; flex-direction: column; gap: 4px; }
.pp-tools { display: flex; align-items: center; gap: 2px; }
.pp-spacer { flex: 1; }
.pp-tool { width: 22px; height: 20px; display: flex; align-items: center; justify-content: center; padding: 0; background: var(--c-button, #545454); color: var(--text, #dedfe1); border: 1px solid rgba(0, 0, 0,0.35); border-radius: 4px; cursor: pointer; }
.pp-tool:hover:not(:disabled) { filter: brightness(1.15); }
.pp-tool:disabled { opacity: .45; cursor: default; }
.paint-palette .pp-swatch { width: 20px; height: 20px; }
.pp-add { background: rgba(255, 255, 255,0.06); color: var(--text, #dedfe1); display: flex; align-items: center; justify-content: center; }
.th-pop { display: flex; align-items: center; gap: 2px; background: none; border: 1px solid transparent; color: var(--text, #dedfe1); font: inherit; font-size: 12px; padding: 1px 6px; border-radius: 4px; cursor: pointer; }
.th-pop:hover { background: rgba(255, 255, 255,0.08); }
.th-brush img { border-radius: 3px; }
.paint-tex-preview { display: block; margin: 4px auto; border-radius: 4px; }
.tool-header:has(.th-brush) { min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.tool-header:has(.th-brush) > * { flex-shrink: 0; }
`;
  document.head.append(style);
}
