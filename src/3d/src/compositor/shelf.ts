// Asset shelf of the Compositor: the built-in effects (compositor/effects.ts) as thumbnails along the
// bottom of the editor, with category tabs and a search field. Clicking an effect adds its node
// group, attached to the pointer like a node from the Add menu. Thumbnails show each effect applied
// to a small generated test picture.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import type { DocumentData } from '../data/types';
import { EFFECTS, EFFECT_CATEGORIES, effectGroup, effectPreviewGroup, type Effect } from './effects';
import { runCompositorGroup } from './run';
import { addMenuExtras } from '../nodes/editor/context';
import type { MenuItem, SearchEntry } from '../ui/menu';

export interface ShelfHost {
  showShelf: boolean;
  shelfTab: string;
  shelfSearch: string;
  addNodeInteractive(idname: string, settings: Record<string, unknown>, at?: { x: number; y: number }, onCancel?: () => void): void;
  providerId: string;
}

/** Add an effect's node group to the editor's tree (the node follows the pointer). */
export function addEffect(ed: ShelfHost, fx: Effect) {
  const fresh = !Object.values(app.doc.node_groups).some((g) => (g as { effect_id?: string }).effect_id === fx.id);
  const g = effectGroup(app.doc, fx);
  ed.addNodeInteractive('CompositorNodeGroup', { node_tree: g.id }, undefined, fresh ? () => delete app.doc.node_groups[g.id] : undefined);
}

// ---------------------------------------------------------------------------
// thumbnails

const TW = 96,
  TH = 64;
const thumbs = new Map<string, string | null>();
let source: Float32Array | null = null;

/** Test picture: sky gradient, a sun, hills and a checker floor (linear, premultiplied, bottom-up rows). */
function testImage(): Float32Array {
  if (source) return source;
  const d = new Float32Array(TW * TH * 4);
  for (let y = 0; y < TH; y++)
    for (let x = 0; x < TW; x++) {
      const u = x / (TW - 1),
        v = y / (TH - 1);
      let c: number[];
      const hill = 0.38 + 0.08 * Math.sin(u * 7.0) + 0.04 * Math.sin(u * 17 + 1);
      if (v < hill) {
        const check = (Math.floor(u * 12) + Math.floor(v * 10)) % 2 ? 0.06 : 0.12;
        c = [check * 1.4, check * 2.2, check * 1.1];
      } else {
        const t = (v - hill) / (1 - hill);
        c = [0.9 - 0.75 * t, 0.55 - 0.3 * t, 0.25 + 0.45 * t];
        const sd = Math.hypot(u - 0.68, v - 0.62);
        if (sd < 0.09) c = [3, 2.4, 1.2];
        else c = c.map((x, i) => x + [0.6, 0.35, 0.1][i] * Math.exp(-sd * 9));
      }
      d.set([c[0], c[1], c[2], 1], (y * TW + x) * 4);
    }
  source = d;
  return d;
}

const toSrgb = (c: number) => {
  c = Math.max(0, Math.min(1, c));
  return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
};

function thumbnail(doc: DocumentData, fx: Effect): string | null {
  if (thumbs.has(fx.id)) return thumbs.get(fx.id)!;
  let url: string | null = null;
  try {
    const r = runCompositorGroup(doc, effectPreviewGroup(doc, fx), { data: testImage(), width: TW, height: TH });
    if (r) {
      const c = document.createElement('canvas');
      c.width = TW;
      c.height = TH;
      const img = new ImageData(TW, TH);
      for (let y = 0; y < TH; y++)
        for (let x = 0; x < TW; x++) {
          const s = ((TH - 1 - y) * TW + x) * 4,
            o = (y * TW + x) * 4;
          const a = r.data[s + 3] || 1;
          img.data[o] = toSrgb(r.data[s] / a);
          img.data[o + 1] = toSrgb(r.data[s + 1] / a);
          img.data[o + 2] = toSrgb(r.data[s + 2] / a);
          img.data[o + 3] = 255;
        }
      c.getContext('2d')!.putImageData(img, 0, 0);
      url = c.toDataURL();
    }
  } catch (e) {
    console.warn('Effect thumbnail failed', e);
  }
  thumbs.set(fx.id, url);
  return url;
}

// ---------------------------------------------------------------------------
// shelf region

export function drawShelf(ed: ShelfHost): Child {
  if (!ed.showShelf) return null;
  const q = ed.shelfSearch.trim().toLowerCase();
  const list = EFFECTS.filter((fx) => (ed.shelfTab === 'All' || fx.category === ed.shelfTab) && (!q || fx.name.toLowerCase().includes(q) || fx.description.toLowerCase().includes(q)));
  const stop = (e: Event) => e.stopPropagation();
  return h(
    'div',
    { class: 'cmp-shelf', onpointerdown: stop, onwheel: stop, oncontextmenu: stop },
    h(
      'div',
      { class: 'cmp-shelf-bar' },
      ['All', ...EFFECT_CATEGORIES].map((t) =>
        h(
          'button',
          {
            key: t,
            class: { 'cmp-shelf-tab': true, on: ed.shelfTab === t },
            onclick: () => {
              ed.shelfTab = t;
              app.changed('ui');
            },
          },
          t,
        ),
      ),
      h('span', { class: 'hdr-spacer' }),
      h(
        'label',
        { class: 'cmp-shelf-search' },
        icon('search'),
        h('input', {
          type: 'search',
          placeholder: 'Search',
          value: ed.shelfSearch,
          oninput: (e: Event) => {
            ed.shelfSearch = (e.target as HTMLInputElement).value;
            app.changed('ui');
          },
          onkeydown: (e: KeyboardEvent) => e.stopPropagation(),
        }),
      ),
    ),
    h(
      'div',
      { class: 'cmp-shelf-tiles' },
      list.length
        ? list.map((fx) => {
            const url = thumbnail(app.doc, fx);
            return h(
              'button',
              {
                key: fx.id,
                class: 'cmp-shelf-tile',
                'data-effect': fx.id,
                'data-tip': `${fx.name}\n${fx.description}`,
                onclick: () => addEffect(ed, fx),
              },
              url ? h('img', { src: url, alt: '', draggable: false }) : h('span', { class: 'cmp-shelf-noimg' }, icon('node_tree')),
              h('span', { class: 'cmp-shelf-name' }, fx.name),
            );
          })
        : h('span', { class: 'prop-note' }, 'No matching effects'),
    ),
  );
}

// Add menu and Add search of the Compositor: the effects by category
addMenuExtras.push({
  items: (edAny) => {
    const ed = edAny as ShelfHost;
    if (ed.providerId !== 'COMPOSITOR') return [];
    return EFFECT_CATEGORIES.map(
      (cat): MenuItem => ({
        label: cat,
        submenu: () => EFFECTS.filter((fx) => fx.category === cat).map((fx) => ({ label: fx.name, icon: 'node_tree', description: fx.description, action: () => addEffect(ed, fx) })),
      }),
    );
  },
  search: (edAny) => {
    const ed = edAny as ShelfHost;
    if (ed.providerId !== 'COMPOSITOR') return [];
    return EFFECTS.map((fx): SearchEntry => ({ label: fx.name, path: fx.category, run: () => addEffect(ed, fx) }) as SearchEntry);
  },
});
