// Color palettes: Palette data-blocks (doc.palettes) referenced by the paint settings of each mode
// (tool_settings.sculpt / vertex_paint / image_paint `.palette`), the palette.* operators, the
// palette template (data-block selector, color grid, add / remove / sort / move buttons) and
// bpy.data.palettes.
import { app, registerOperators, type OpContext } from '../app/app';
import type { DocumentData } from '../data/types';
import { uid } from '../data/defaults';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { openMenu } from '../ui/menu';
import { imageCanvas } from '../render/images';
import { linearToSrgb } from './math';
import { paintImage } from './tpaint';
import { extractColors, hasColor, joinColors, moveColor, paletteColor, sortColors, type PaletteData, type PaletteSort } from './palettemath';

export type { PaletteData } from './palettemath';

/** Paint settings that can hold a palette. */
export type PaletteOwner = 'SCULPT' | 'VERTEX_PAINT' | 'TEXTURE_PAINT';

export function palettesOf(doc: DocumentData = app.doc): Record<string, PaletteData> {
  const d = doc as DocumentData & { palettes?: Record<string, PaletteData> };
  return (d.palettes ??= {});
}

type Holder = { palette?: string | null };

/** The paint settings struct of a mode (created on demand). */
export function paintSettingsOf(owner: PaletteOwner, doc: DocumentData = app.doc): Holder {
  const ts = doc.scene.tool_settings as unknown as Record<string, Holder | undefined>;
  const key = owner === 'SCULPT' ? 'sculpt' : owner === 'VERTEX_PAINT' ? 'vertex_paint' : 'image_paint';
  return (ts[key] ??= {});
}

/** Paint settings owner for an operator context: the Image Editor paints with the texture paint settings. */
export function ownerFor(ctx?: { area?: { type?: string } | null }): PaletteOwner | null {
  if (ctx?.area?.type === 'IMAGE_EDITOR') return 'TEXTURE_PAINT';
  const m = app.doc.mode;
  return m === 'SCULPT' || m === 'VERTEX_PAINT' || m === 'TEXTURE_PAINT' ? m : null;
}

export function activePalette(owner: PaletteOwner | null, doc: DocumentData = app.doc): PaletteData | null {
  if (!owner) return null;
  migrateLegacyPalette(doc);
  const id = paintSettingsOf(owner, doc).palette;
  return (id && palettesOf(doc)[id]) || null;
}

function uniquePaletteName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(palettesOf(doc)).map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

export function newPalette(doc: DocumentData, name = 'Palette'): PaletteData {
  const p: PaletteData = { id: uid('pal'), name: uniquePaletteName(doc, name), colors: [], active_index: -1 };
  palettesOf(doc)[p.id] = p;
  return p;
}

/** Older files kept a plain color list on the unified paint settings: turn it into a palette. */
function migrateLegacyPalette(doc: DocumentData) {
  const up = doc.scene.tool_settings.unified_paint as { palette?: [number, number, number][] };
  if (!Array.isArray(up.palette)) return;
  const list = up.palette;
  delete up.palette;
  if (!list.length) return;
  const p = newPalette(doc);
  p.colors = list.map((c) => paletteColor(c));
  p.active_index = 0;
  for (const o of ['SCULPT', 'VERTEX_PAINT', 'TEXTURE_PAINT'] as PaletteOwner[]) {
    const s = paintSettingsOf(o, doc);
    if (!s.palette) s.palette = p.id;
  }
}

/** Palette users (paint settings that point at it). */
export function paletteUsers(doc: DocumentData, id: string): number {
  return (['SCULPT', 'VERTEX_PAINT', 'TEXTURE_PAINT'] as PaletteOwner[]).filter((o) => paintSettingsOf(o, doc).palette === id).length;
}

/** Make the color at `index` active and use it as the brush color. */
export function pickPaletteColor(pal: PaletteData, index: number, secondary = false) {
  const c = pal.colors[index];
  if (!c) return;
  pal.active_index = index;
  const up = app.doc.scene.tool_settings.unified_paint;
  if (secondary) up.secondary_color = [c.color[0], c.color[1], c.color[2]];
  else up.color = [c.color[0], c.color[1], c.color[2]];
}

// ---------------------------------------------------------------------------
// operators

const pollPalette = (ctx: OpContext) => !!activePalette(ownerFor(ctx));

registerOperators([
  {
    idname: 'palette.new',
    label: 'Add New Palette',
    description: 'Create a new, empty color palette for the current paint mode',
    poll: (ctx) => !!ownerFor(ctx),
    exec: (ctx) => {
      const owner = ownerFor(ctx)!;
      const p = newPalette(ctx.doc);
      paintSettingsOf(owner, ctx.doc).palette = p.id;
    },
  },
  {
    idname: 'palette.color_add',
    label: 'New Palette Color',
    description: 'Add the current brush color to the palette and make it the active color',
    poll: pollPalette,
    exec: (ctx) => {
      const pal = activePalette(ownerFor(ctx))!;
      const up = ctx.doc.scene.tool_settings.unified_paint;
      const c = app.doc.mode === 'WEIGHT_PAINT' ? [up.weight, up.weight, up.weight] : up.color;
      // insert after the active color, like adding to a list
      const at = pal.active_index >= 0 ? pal.active_index + 1 : pal.colors.length;
      pal.colors.splice(at, 0, { ...paletteColor(c), weight: up.weight, strength: 1 });
      pal.active_index = at;
    },
  },
  {
    idname: 'palette.color_delete',
    label: 'Delete Palette Color',
    description: 'Remove the active color from the palette',
    poll: (ctx) => {
      const pal = activePalette(ownerFor(ctx));
      return !!pal && pal.active_index >= 0 && pal.active_index < pal.colors.length;
    },
    exec: (ctx) => {
      const pal = activePalette(ownerFor(ctx))!;
      pal.colors.splice(pal.active_index, 1);
      pal.active_index = Math.min(pal.active_index, pal.colors.length - 1);
    },
  },
  {
    idname: 'palette.color_move',
    label: 'Move Palette Color',
    description: 'Move the active color one place up or down in the palette',
    props: [{ id: 'type', label: 'Direction', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: (ctx) => {
      const pal = activePalette(ownerFor(ctx));
      return !!pal && pal.active_index >= 0 && pal.colors.length > 1;
    },
    exec: (ctx, p) => {
      const pal = activePalette(ownerFor(ctx))!;
      const j = moveColor(pal.colors, pal.active_index, p.type === 'DOWN' ? 'DOWN' : 'UP');
      if (j === pal.active_index) return 'CANCELLED';
      pal.active_index = j;
    },
  },
  {
    idname: 'palette.sort',
    label: 'Sort Palette',
    description: 'Sort the colors of the palette',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'HSV',
        items: [
          ['HSV', 'Hue, Saturation, Value'],
          ['SVH', 'Saturation, Value, Hue'],
          ['VHS', 'Value, Hue, Saturation'],
          ['LUMINANCE', 'Luminance'],
        ],
      },
    ],
    poll: (ctx) => (activePalette(ownerFor(ctx))?.colors.length ?? 0) > 1,
    exec: (ctx, p) => {
      const pal = activePalette(ownerFor(ctx))!;
      const act = pal.colors[pal.active_index];
      pal.colors = sortColors(pal.colors, p.type as PaletteSort);
      pal.active_index = act ? pal.colors.indexOf(act) : -1;
    },
  },
  {
    idname: 'palette.join',
    label: 'Join Palette Swatches',
    description: 'Add the colors of another palette to the active one and remove the other palette',
    props: [{ id: 'palette', label: 'Palette', type: 'string', default: '' }],
    poll: pollPalette,
    invoke: (ctx, p) => {
      if (p.palette) return app.run('palette.join', p, { invoke: false, area: ctx.area }) === 'FINISHED' ? 'CANCELLED' : 'CANCELLED';
      const pal = activePalette(ownerFor(ctx))!;
      const others = Object.values(palettesOf(ctx.doc)).filter((x) => x.id !== pal.id);
      if (!others.length) {
        app.report('INFO', 'There is no other palette to join');
        return 'CANCELLED';
      }
      openMenu(
        others.map((o) => ({ label: o.name, icon: 'paint_palette', action: () => void app.run('palette.join', { palette: o.name }, { invoke: false, area: ctx.area }) })),
        { x: ctx.event?.x ?? app.pointer.x, y: ctx.event?.y ?? app.pointer.y },
        { title: 'Join Palette' },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const pal = activePalette(ownerFor(ctx))!;
      const name = String(p.palette ?? '');
      const src = Object.values(palettesOf(ctx.doc)).find((x) => x.name === name || x.id === name);
      if (!src || src.id === pal.id) {
        app.report('ERROR', `Palette "${name}" not found`);
        return 'CANCELLED';
      }
      joinColors(pal.colors, src.colors);
      if (pal.active_index < 0 && pal.colors.length) pal.active_index = 0;
      // the joined palette goes away unless something else uses it
      for (const o of ['SCULPT', 'VERTEX_PAINT', 'TEXTURE_PAINT'] as PaletteOwner[]) {
        const s = paintSettingsOf(o, ctx.doc);
        if (s.palette === src.id) s.palette = pal.id;
      }
      if (!src.use_fake_user) delete palettesOf(ctx.doc)[src.id];
    },
  },
  {
    idname: 'palette.extract_from_image',
    label: 'Extract Palette from Image',
    description: 'Create a palette from the distinct colors of the image being edited or painted',
    props: [{ id: 'threshold', label: 'Threshold', type: 'int', default: 1, min: 1, max: 6 }],
    poll: (ctx) => !!imageForPalette(ctx),
    exec: (ctx, p) => {
      const img = imageForPalette(ctx);
      if (!img) return 'CANCELLED';
      let data: Uint8ClampedArray;
      try {
        const cv = imageCanvas(img);
        const g = cv.getContext('2d', { willReadFrequently: true });
        if (!g) return 'CANCELLED';
        data = g.getImageData(0, 0, cv.width, cv.height).data;
      } catch {
        app.report('ERROR', 'The image pixels are not available');
        return 'CANCELLED';
      }
      const cols = extractColors(data, Number(p.threshold) || 1);
      if (!cols.length) {
        app.report('WARNING', 'The image has no visible pixels');
        return 'CANCELLED';
      }
      const pal = newPalette(ctx.doc, img.name.replace(/\.[a-z0-9]+$/i, '') || 'Palette');
      pal.colors = cols;
      pal.active_index = 0;
      const owner = ownerFor(ctx);
      if (owner) paintSettingsOf(owner, ctx.doc).palette = pal.id;
      app.report('INFO', `Palette created with ${cols.length} colors`);
    },
  },
]);

/** The image a palette is extracted from: the Image Editor's image, else the texture paint image. */
function imageForPalette(ctx: OpContext) {
  if (ctx.area?.type === 'IMAGE_EDITOR') {
    const im = (ctx.area.editor as { image?: unknown } | undefined)?.image;
    if (im && typeof im === 'object' && 'id' in im) return ctx.doc.images[(im as { id: string }).id] ?? null;
  }
  return app.doc.mode === 'TEXTURE_PAINT' ? paintImage(app.activeObject) : null;
}

// ---------------------------------------------------------------------------
// UI: palette template

const css = (c: ArrayLike<number>) => `rgb(${[0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c[i]))) * 255)).join(',')})`;

const run = (op: string, props: Record<string, unknown> = {}) => app.run(op, props, { invoke: false });

/**
 * Palette data-block selector and color grid of a paint mode. `prefix` keeps keys unique when the
 * template is drawn in several places.
 */
export function paletteTemplate(owner: PaletteOwner, prefix: string, selector: (cur: PaletteData | null, set: (id: string | null) => void, create: () => void) => Child): Child {
  const pal = activePalette(owner);
  const settings = paintSettingsOf(owner);
  const set = (id: string | null) => {
    settings.palette = id;
    app.pushUndo('Assign Palette');
    app.changed('ui');
  };
  const sel = selector(pal, set, () => {
    const p = newPalette(app.doc);
    set(p.id);
  });
  if (!pal) return h('div', { class: 'pp-wrap' }, sel);
  const up = app.doc.scene.tool_settings.unified_paint;
  const btn = (key: string, ic: string, tip: string, onclick: (e: MouseEvent) => void, disabled = false) =>
    h('button', { key: `${prefix}-${key}`, class: 'pp-tool', 'data-tip': tip, disabled, onclick }, icon(ic));
  const act = pal.active_index;
  return h(
    'div',
    { class: 'pp-wrap' },
    sel,
    h(
      'div',
      { class: 'pp-tools' },
      btn('add', 'add', 'New Palette Color\nAdd the brush color after the active color', () => run('palette.color_add')),
      btn('del', 'remove', 'Delete Palette Color\nRemove the active color', () => run('palette.color_delete'), act < 0),
      h(
        'button',
        {
          key: `${prefix}-menu`,
          class: 'pp-tool',
          'data-tip': 'Palette Specials',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              [
                { heading: 'Sort' },
                { label: 'By Hue, Saturation, Value', op: 'palette.sort', props: { type: 'HSV' } },
                { label: 'By Saturation, Value, Hue', op: 'palette.sort', props: { type: 'SVH' } },
                { label: 'By Value, Hue, Saturation', op: 'palette.sort', props: { type: 'VHS' } },
                { label: 'By Luminance', op: 'palette.sort', props: { type: 'LUMINANCE' } },
                { separator: true },
                { label: 'Join Palette…', op: 'palette.join' },
                { label: 'Extract Palette from Image', op: 'palette.extract_from_image' },
              ],
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('down_arrow_hlt'),
      ),
      h('div', { class: 'pp-spacer' }),
      btn('up', 'triangle_up', 'Move Palette Color Up', () => run('palette.color_move', { type: 'UP' }), act <= 0),
      btn('down', 'triangle_down', 'Move Palette Color Down', () => run('palette.color_move', { type: 'DOWN' }), act < 0 || act >= pal.colors.length - 1),
    ),
    h(
      'div',
      { class: 'paint-palette' },
      pal.colors.map((c, i) =>
        h('button', {
          key: `${prefix}-${i}`,
          class: { 'pp-swatch': true, on: i === act, match: hasColor([c], up.color) },
          style: { background: css(c.color) },
          'data-index': String(i),
          'data-tip': 'Click: use this color · Shift click: use it as the secondary color',
          onclick: (e: MouseEvent) => {
            pickPaletteColor(pal, i, e.shiftKey);
            app.pushUndo('Palette Color');
            app.changed('ui');
          },
        }),
      ),
    ),
  );
}
