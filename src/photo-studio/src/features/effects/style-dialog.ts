import type { Editor } from '../../editor';
import { blendLabel, blends, findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { layerLock } from '../../model/locks';
import { svg } from '../../app/icons';
import { formDialog } from '../../ui/dialog';
import {
  defaultBevel, defaultColorOverlay, defaultDropShadow, defaultInnerGlow, defaultInnerShadow, defaultOuterGlow, defaultSatin, defaultStroke,
  type BevelFx, type GlowFx, type GradientOverlayFx, type LayerStyle, type PatternOverlayFx, type SatinFx, type ShadowFx, type StrokeFx,
} from '../../imaging/effects/types';
import { gradientPresets } from '../../imaging/gradient/presets';
import { mountFields, type Field } from './controls';
import { showStyleThumbnail, saveUserStyle } from './style-thumbs';
import { resolveGradient } from './state';
import { blendIfChannels, cleanBlending, openRanges, type AdvancedBlending, type BlendIfChannel } from '../../model/blending';
import { effectLabels, effectOrder as order, type Multi, type Single } from './effect-order';

export { effectLabels };

// The Layer Style dialog: effect list on the left (checkbox per effect, +
// for effects that can repeat), the selected effect's controls on the right.
// Edits preview live on the canvas; OK records one history step and Cancel
// restores the document as it was.
type Section = { key: 'blending' } | { key: Single } | { key: 'bevel-contour' } | { key: 'bevel-texture' } | { key: Multi; index: number };
const defaultGradientOverlay = (): GradientOverlayFx => ({
  enabled: true, blendMode: 'normal', opacity: 1, style: 'linear', angle: 90, scale: 1, alignWithLayer: true, dither: true,
  gradient: structuredClone(gradientPresets[0].gradients[2]),
});
const defaultPatternOverlay = (): PatternOverlayFx => ({ enabled: true, blendMode: 'normal', opacity: 1, patternId: 'checker', scale: 1, linkWithLayer: true });
const singleDefaults: Record<Single, () => object> = {
  outerGlow: defaultOuterGlow, innerGlow: defaultInnerGlow, bevel: defaultBevel, satin: defaultSatin, patternOverlay: defaultPatternOverlay,
};
const multiDefaults: Record<Multi, () => object> = {
  dropShadow: defaultDropShadow, innerShadow: defaultInnerShadow, colorOverlay: defaultColorOverlay, gradientOverlay: defaultGradientOverlay, stroke: defaultStroke,
};
const isMulti = (k: string): k is Multi => k in multiDefaults;

/** Removes disabled effects (and the style itself when nothing is left). */
export function cleanStyle(style: LayerStyle): LayerStyle | undefined {
  const s: LayerStyle = structuredClone(style);
  for (const k of Object.keys(multiDefaults) as Multi[]) {
    const list = (s[k] as { enabled: boolean }[] | undefined)?.filter((f) => f.enabled);
    if (list?.length) (s as Record<string, unknown>)[k] = list;
    else delete s[k];
  }
  for (const k of Object.keys(singleDefaults) as Single[]) if (s[k] && !s[k]!.enabled) delete s[k];
  const any = Object.keys(multiDefaults).some((k) => k in s) || Object.keys(singleDefaults).some((k) => k in s);
  return any ? s : undefined;
}

let open = false;
export async function openStyleDialog(e: Editor, start?: string) {
  const l = e.layer;
  if (open || !l) return;
  if (e.selectedIds.size > 1) {
    e.message('Select a single layer to edit its layer style.');
    return;
  }
  if (l.kind === 'adjustment') {
    e.message('Adjustment layers cannot have a layer style.');
    return;
  }
  if (layerLock(e.doc.layers, l.id, 'all')) {
    e.message('Unlock this layer to edit its layer style.');
    return;
  }
  open = true;
  e.transform.apply();
  const original = e.doc;
  const id = l.id;
  const style: LayerStyle = structuredClone((l.style as LayerStyle | undefined) ?? { enabled: true });
  style.enabled = true;
  // The light is document-wide; a style's own values are the fallback for
  // documents that never set one.
  const light = { angle: e.doc.globalLight?.angle ?? style.globalAngle ?? 120, altitude: e.doc.globalLight?.altitude ?? style.globalAltitude ?? 30 };
  const lightBefore = { ...light };
  const blending = { blend: l.blend, opacity: l.opacity, fillOpacity: l.fillOpacity ?? 1 };
  const adv: AdvancedBlending = structuredClone(l.blending ?? {});
  const ui = { channel: (blendIfChannels.find((c) => adv.ranges?.[c]) ?? 'gray') as BlendIfChannel };
  let previewOn = true;
  let section: Section = { key: 'blending' };
  if (start) {
    const [k, i] = start.split(':');
    if (isMulti(k)) {
      if (!style[k]?.length) (style as Record<string, unknown>)[k] = [multiDefaults[k]()];
      section = { key: k, index: Math.min(Number(i) || 0, style[k]!.length - 1) };
    } else if (k in singleDefaults) {
      (style as Record<string, unknown>)[k] ??= singleDefaults[k as Single]();
      section = { key: k as Single };
    }
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'layer-style-dialog';
  dialog.setAttribute('aria-label', 'Layer Style');
  dialog.innerHTML = `<form method="dialog" novalidate><h2>Layer Style</h2><div class="ls-body"><nav class="ls-list" aria-label="Effects"></nav><div class="ls-panel"><h3 class="ls-title"></h3><div class="ls-fields"></div></div></div><footer class="ls-side dialog-footer"><img class="ls-thumb" alt="Style sample" width="72" height="72" hidden><button type="button" data-new-style>New Style…</button><label class="fx-check"><input type="checkbox" data-preview checked>Preview</label><button type="button" data-cancel>Cancel</button><button type="submit" class="primary" data-ok>OK</button></footer></form>`;
  e.root.append(dialog);
  const list = dialog.querySelector<HTMLElement>('.ls-list')!;
  const title = dialog.querySelector<HTMLElement>('.ls-title')!;
  const thumb = dialog.querySelector<HTMLImageElement>('.ls-thumb')!;

  const fxOf = (s: Section): { enabled: boolean } | undefined => {
    if (s.key === 'blending') return undefined;
    if (s.key === 'bevel-contour' || s.key === 'bevel-texture') return style.bevel;
    if ('index' in s) return (style[s.key] as { enabled: boolean }[] | undefined)?.[s.index];
    return style[s.key] as { enabled: boolean } | undefined;
  };
  const previewDoc = (): PhotoDocument => {
    const replace = (layers: Layer[]): Layer[] =>
      layers.map((x) =>
        x.id === id
          ? { ...x, style: previewOn ? (structuredClone(style) as Record<string, unknown>) : x.style, ...(previewOn ? { ...blending, blending: cleanBlending(adv) } : {}) }
          : x.children.length ? { ...x, children: replace(x.children) } : x,
      );
    return { ...original, layers: replace(original.layers), ...(previewOn ? { globalLight: { ...light } } : {}) };
  };
  let thumbFrame = 0;
  const refresh = () => {
    e.preview(previewDoc());
    if (thumbFrame) return;
    thumbFrame = requestAnimationFrame(() => {
      thumbFrame = 0;
      showStyleThumbnail(thumb, structuredClone(style), 72, blending.fillOpacity);
      thumb.onload = () => (thumb.hidden = false);
    });
  };
  const renderList = () => {
    const row = (key: string, label: string, opts: { index?: number; sub?: boolean; multi?: boolean } = {}) => {
      const s: Section = key === 'blending' ? { key: 'blending' } : opts.index !== undefined ? { key: key as Multi, index: opts.index } : ({ key } as Section);
      const fx = fxOf(s);
      const checked = key === 'bevel-contour' ? !!style.bevel?.contour : key === 'bevel-texture' ? !!style.bevel?.texture : !!fx?.enabled;
      const active = section.key === s.key && ('index' in section ? section.index === opts.index : true);
      const sel = `${key}${opts.index !== undefined ? ':' + opts.index : ''}`;
      return `<div class="ls-item ${active ? 'active' : ''} ${opts.sub ? 'sub' : ''}" data-section="${sel}">${key === 'blending' ? '<span class="ls-check-spacer"></span>' : `<input type="checkbox" data-toggle="${sel}" ${checked ? 'checked' : ''} aria-label="Enable ${escapeXML(label)}">`}<button type="button" class="ls-name" data-pick="${sel}">${escapeXML(label)}</button>${opts.multi ? `<button type="button" class="icon-button ls-add" data-add="${sel}" title="Add another ${escapeXML(label)}" aria-label="Add another ${escapeXML(label)}">${svg('plus', 12)}</button>` : ''}</div>`;
    };
    let html = '';
    for (const o of order) {
      if (o.multi) {
        const n = Math.max(1, (style[o.key as Multi] as unknown[] | undefined)?.length ?? 0);
        for (let i = 0; i < n; i++) html += row(o.key, o.label, { index: i, multi: true });
      } else html += row(o.key, o.label);
      if (o.key === 'bevel') html += row('bevel-contour', 'Contour', { sub: true }) + row('bevel-texture', 'Texture', { sub: true });
    }
    const canDelete = 'index' in section && ((style[section.key] as unknown[] | undefined)?.length ?? 0) > 1;
    html += `<div class="ls-list-footer"><button type="button" class="icon-button" data-delete ${canDelete ? '' : 'disabled'} title="Delete effect" aria-label="Delete effect">${svg('trash-2', 14)}</button></div>`;
    list.innerHTML = html;
    list.querySelector('.ls-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const parse = (sel: string): Section => {
    const [k, i] = sel.split(':');
    if (isMulti(k)) return { key: k, index: Number(i) || 0 };
    return { key: k } as Section;
  };
  // Clicking an effect's name or checkbox creates it with defaults if needed.
  const ensure = (s: Section) => {
    if (s.key === 'blending') return;
    if (s.key === 'bevel-contour' || s.key === 'bevel-texture') {
      style.bevel ??= defaultBevel();
      style.bevel.enabled = true;
      if (s.key === 'bevel-contour') style.bevel.contour ??= { contour: { name: 'Linear', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, range: 0.5 };
      else style.bevel.texture ??= { patternId: 'canvas', scale: 1, depth: 1, linkWithLayer: true };
      return;
    }
    if ('index' in s) {
      const arr = ((style as Record<string, unknown>)[s.key] ??= []) as { enabled: boolean }[];
      if (!arr[s.index]) arr[s.index] = multiDefaults[s.key]() as { enabled: boolean };
      arr[s.index].enabled = true;
      return;
    }
    const k = s.key as Single;
    (style as Record<string, unknown>)[k] ??= singleDefaults[k]();
    style[k]!.enabled = true;
  };
  const renderPanel = () => {
    const label = section.key === 'bevel-contour' ? 'Contour' : section.key === 'bevel-texture' ? 'Texture' : effectLabels[section.key];
    title.textContent = label;
    mount();
  };
  // A fresh container per effect drops the previous effect's listeners.
  const mount = () => {
    const current = dialog.querySelector<HTMLElement>('.ls-fields')!;
    const fresh = current.cloneNode(false) as HTMLElement;
    current.replaceWith(fresh);
    mountFields(e, fresh, () => fieldsFor(e, style, section, blending, adv, light, ui), (_structural, final) => {
      refresh();
      if (final) renderList();
    });
  };
  list.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const pick = t.closest<HTMLElement>('[data-pick]')?.dataset.pick;
    const add = t.closest<HTMLElement>('[data-add]')?.dataset.add;
    if (pick) {
      section = parse(pick);
      ensure(section);
    } else if (add) {
      const s = parse(add) as { key: Multi; index: number };
      const arr = ((style as Record<string, unknown>)[s.key] ??= []) as object[];
      const copy = arr[s.index] ? structuredClone(arr[s.index]) : multiDefaults[s.key]();
      arr.splice(s.index + 1, 0, copy);
      section = { key: s.key, index: s.index + 1 };
      ensure(section);
    } else if (t.closest('[data-delete]') && 'index' in section) {
      const arr = style[section.key] as object[];
      arr.splice(section.index, 1);
      section = { key: section.key, index: Math.max(0, section.index - 1) };
    } else return;
    renderList();
    renderPanel();
    refresh();
  });
  list.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const sel = t.dataset.toggle;
    if (!sel) return;
    const s = parse(sel);
    if (t.checked) {
      ensure(s);
      section = s;
    } else if (s.key === 'bevel-contour') delete style.bevel!.contour;
    else if (s.key === 'bevel-texture') delete style.bevel!.texture;
    else {
      const fx = fxOf(s);
      if (fx) fx.enabled = false;
    }
    renderList();
    renderPanel();
    refresh();
  });
  const close = (commit: boolean) => {
    cancelAnimationFrame(thumbFrame);
    dialog.close();
    dialog.remove();
    document.querySelector('.fx-popover')?.remove();
    open = false;
    if (!commit) {
      e.preview(e.doc);
      return;
    }
    const cleaned = cleanStyle(style);
    if (cleaned) {
      delete cleaned.globalAngle;
      delete cleaned.globalAltitude;
    }
    const advanced = cleanBlending(adv);
    const lightChanged = light.angle !== lightBefore.angle || light.altitude !== lightBefore.altitude;
    e.command('Layer Style', (d) => {
      const x = findLayer(d.layers, id);
      if (!x) return;
      if (cleaned) x.style = cleaned as Record<string, unknown>;
      else delete x.style;
      x.blend = blending.blend;
      x.opacity = blending.opacity;
      x.fillOpacity = blending.fillOpacity;
      if (x.fillOpacity === 1) delete x.fillOpacity;
      if (advanced) x.blending = advanced;
      else delete x.blending;
      // Effects that use the global light now follow the document's light.
      if (lightChanged || (!d.globalLight && cleaned)) d.globalLight = { ...light };
    });
  };
  dialog.querySelector('form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    close(true);
  });
  dialog.querySelector('[data-cancel]')!.addEventListener('click', () => close(false));
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    if (document.querySelector('.fx-popover')) return;
    close(false);
  });
  // Enter in a field commits that field, not the whole dialog.
  dialog.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('input:not([type=checkbox]),select')) {
      ev.preventDefault();
      (ev.target as HTMLElement).dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  dialog.querySelector<HTMLInputElement>('[data-preview]')!.addEventListener('change', (ev) => {
    previewOn = (ev.target as HTMLInputElement).checked;
    refresh();
  });
  dialog.querySelector('[data-new-style]')!.addEventListener('click', async () => {
    const v = await formDialog('New Style', [{ name: 'name', label: 'Name', value: 'Style' }], 'Save');
    const name = v?.name.trim();
    if (!name) return;
    const cleaned = cleanStyle(style);
    if (!cleaned) {
      e.message('Enable at least one effect to save a style.');
      return;
    }
    saveUserStyle(name, cleaned);
    e.dock?.update();
    e.message(`Style “${name}” saved to the Styles panel.`);
  });
  // Opening on an effect turns it on.
  if (start) ensure(section);
  renderList();
  renderPanel();
  dialog.showModal();
  draggable(dialog);
  refresh();
}
/** Starts a dialog at the right of the window (clear of most of the canvas)
 * and lets its title bar move it, so the live preview stays visible. */
export function draggable(dialog: HTMLDialogElement) {
  const place = (x: number, y: number) => {
    const w = dialog.offsetWidth, h = dialog.offsetHeight;
    dialog.style.left = `${w >= innerWidth - 16 ? Math.max(0, (innerWidth - w) / 2) : Math.max(0, Math.min(innerWidth - w, x))}px`;
    dialog.style.top = `${Math.max(0, Math.min(innerHeight - 40, y))}px`;
    void h;
  };
  dialog.classList.add('floating-dialog');
  place(innerWidth - dialog.offsetWidth - 16, Math.max(8, Math.min(64, innerHeight - dialog.offsetHeight - 8)));
  const handle = dialog.querySelector<HTMLElement>('h2');
  if (!handle) return;
  handle.addEventListener('pointerdown', (ev) => {
    const r = dialog.getBoundingClientRect();
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    handle.setPointerCapture(ev.pointerId);
    const move = (p: PointerEvent) => place(p.clientX - dx, p.clientY - dy);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

const pct = (label: string, get: () => number, set: (v: number) => void, max = 100): Field => ({ kind: 'slider', label, get, set, min: 0, max, unit: '%', display: 100 });
const px = (label: string, get: () => number, set: (v: number) => void, max = 250, min = 0): Field => ({ kind: 'slider', label, get, set, min, max, unit: 'px' });
type Light = { angle: number; altitude: number };
function lightAngle(light: Light, fx: { angle: number; useGlobalLight: boolean }, label = 'Angle'): Field {
  return {
    kind: 'angle', label,
    get: () => (fx.useGlobalLight ? light.angle : fx.angle),
    set: (v) => {
      fx.angle = v;
      if (fx.useGlobalLight) light.angle = v;
    },
    global: {
      get: () => fx.useGlobalLight,
      set: (v) => {
        fx.useGlobalLight = v;
        if (v) fx.angle = light.angle;
      },
    },
  };
}
const contourField = (label: string, fx: { contour?: import('../../imaging/effects/contour').Contour; antiAliased?: boolean }): Field => ({
  kind: 'contour', label, get: () => fx.contour, set: (c) => (c ? (fx.contour = c) : delete fx.contour),
  aa: { get: () => !!fx.antiAliased, set: (v) => (fx.antiAliased = v) },
});
function shadowFields(light: Light, fx: ShadowFx, inner: boolean): Field[] {
  return [
    { kind: 'heading', label: 'Structure' },
    { kind: 'blend', label: 'Blend Mode', get: () => fx.blendMode, set: (v) => (fx.blendMode = v) },
    { kind: 'color', label: 'Color', get: () => fx.color, set: (v) => (fx.color = v) },
    pct('Opacity', () => fx.opacity, (v) => (fx.opacity = v)),
    lightAngle(light, fx),
    px('Distance', () => fx.distance, (v) => (fx.distance = v), 1000),
    pct(inner ? 'Choke' : 'Spread', () => fx.spread, (v) => (fx.spread = v)),
    px('Size', () => fx.size, (v) => (fx.size = v)),
    { kind: 'heading', label: 'Quality' },
    contourField('Contour', fx),
    pct('Noise', () => fx.noise ?? 0, (v) => (fx.noise = v)),
    ...(inner ? [] : [{ kind: 'check', label: 'Layer Knocks Out Drop Shadow', get: () => fx.knockout !== false, set: (v: boolean) => (fx.knockout = v) } as Field]),
  ];
}
function glowFields(e: Editor, fx: GlowFx, inner: boolean): Field[] {
  const fill = fx.fill;
  return [
    { kind: 'heading', label: 'Structure' },
    { kind: 'blend', label: 'Blend Mode', get: () => fx.blendMode, set: (v) => (fx.blendMode = v) },
    pct('Opacity', () => fx.opacity, (v) => (fx.opacity = v)),
    pct('Noise', () => fx.noise ?? 0, (v) => (fx.noise = v)),
    {
      kind: 'select', label: 'Fill', structural: true, options: [['color', 'Color'], ['gradient', 'Gradient']], get: () => fx.fill.type,
      set: (v) => {
        fx.fill = v === 'gradient'
          ? { type: 'gradient', gradient: resolveGradient(e, { kind: 'solid', colorStops: [{ location: 0, color: fill.type === 'color' ? fill.color : [255, 255, 190] }, { location: 1, color: fill.type === 'color' ? fill.color : [255, 255, 190] }], opacityStops: [{ location: 0, opacity: 1 }, { location: 1, opacity: 0 }] }) }
          : { type: 'color', color: fill.type === 'gradient' ? [255, 255, 190] : fill.color };
      },
    },
    ...(fill.type === 'color'
      ? [{ kind: 'color', label: 'Color', get: () => fill.color, set: (v: [number, number, number]) => (fill.color = v) } as Field]
      : [
          { kind: 'gradient', label: 'Gradient', get: () => fill.gradient, set: (g) => (fill.gradient = resolveGradient(e, g)) } as Field,
          { kind: 'check', label: 'Reverse', get: () => !!fill.reverse, set: (v) => (fill.reverse = v) } as Field,
        ]),
    { kind: 'heading', label: 'Elements' },
    { kind: 'select', label: 'Technique', options: [['softer', 'Softer'], ['precise', 'Precise']], get: () => fx.technique, set: (v) => (fx.technique = v as GlowFx['technique']) },
    ...(inner ? [{ kind: 'select', label: 'Source', options: [['center', 'Center'], ['edge', 'Edge']], get: () => fx.source ?? 'edge', set: (v: string) => (fx.source = v as 'edge') } as Field] : []),
    pct(inner ? 'Choke' : 'Spread', () => fx.spread, (v) => (fx.spread = v)),
    px('Size', () => fx.size, (v) => (fx.size = v)),
    { kind: 'heading', label: 'Quality' },
    contourField('Contour', fx),
    pct('Range', () => fx.range, (v) => (fx.range = v)),
    pct('Jitter', () => fx.jitter, (v) => (fx.jitter = v)),
  ];
}
function bevelFields(light: Light, fx: BevelFx): Field[] {
  return [
    { kind: 'heading', label: 'Structure' },
    { kind: 'select', label: 'Style', options: [['outer-bevel', 'Outer Bevel'], ['inner-bevel', 'Inner Bevel'], ['emboss', 'Emboss'], ['pillow-emboss', 'Pillow Emboss'], ['stroke-emboss', 'Stroke Emboss']], get: () => fx.style, set: (v) => (fx.style = v as BevelFx['style']) },
    { kind: 'select', label: 'Technique', options: [['smooth', 'Smooth'], ['chisel-hard', 'Chisel Hard'], ['chisel-soft', 'Chisel Soft']], get: () => fx.technique, set: (v) => (fx.technique = v as BevelFx['technique']) },
    pct('Depth', () => fx.depth, (v) => (fx.depth = Math.max(0.01, v)), 1000),
    { kind: 'select', label: 'Direction', options: [['up', 'Up'], ['down', 'Down']], get: () => fx.direction, set: (v) => (fx.direction = v as 'up') },
    px('Size', () => fx.size, (v) => (fx.size = v)),
    px('Soften', () => fx.soften, (v) => (fx.soften = v), 16),
    { kind: 'heading', label: 'Shading' },
    lightAngle(light, fx),
    {
      kind: 'slider', label: 'Altitude', min: 0, max: 90, unit: '°',
      get: () => (fx.useGlobalLight ? light.altitude : fx.altitude),
      set: (v) => {
        fx.altitude = v;
        if (fx.useGlobalLight) light.altitude = v;
      },
    },
    { kind: 'contour', label: 'Gloss Contour', get: () => fx.glossContour, set: (c) => (c ? (fx.glossContour = c) : delete fx.glossContour), aa: { get: () => !!fx.glossAntiAliased, set: (v) => (fx.glossAntiAliased = v) } },
    { kind: 'blend', label: 'Highlight Mode', get: () => fx.highlightMode, set: (v) => (fx.highlightMode = v) },
    { kind: 'color', label: 'Highlight Color', get: () => fx.highlightColor, set: (v) => (fx.highlightColor = v) },
    pct('Highlight Opacity', () => fx.highlightOpacity, (v) => (fx.highlightOpacity = v)),
    { kind: 'blend', label: 'Shadow Mode', get: () => fx.shadowMode, set: (v) => (fx.shadowMode = v) },
    { kind: 'color', label: 'Shadow Color', get: () => fx.shadowColor, set: (v) => (fx.shadowColor = v) },
    pct('Shadow Opacity', () => fx.shadowOpacity, (v) => (fx.shadowOpacity = v)),
  ];
}
function satinFields(fx: SatinFx): Field[] {
  return [
    { kind: 'heading', label: 'Structure' },
    { kind: 'blend', label: 'Blend Mode', get: () => fx.blendMode, set: (v) => (fx.blendMode = v) },
    { kind: 'color', label: 'Color', get: () => fx.color, set: (v) => (fx.color = v) },
    pct('Opacity', () => fx.opacity, (v) => (fx.opacity = v)),
    { kind: 'angle', label: 'Angle', get: () => fx.angle, set: (v) => (fx.angle = v) },
    px('Distance', () => fx.distance, (v) => (fx.distance = v)),
    px('Size', () => fx.size, (v) => (fx.size = v)),
    contourField('Contour', fx),
    { kind: 'check', label: 'Invert', get: () => fx.invert, set: (v) => (fx.invert = v) },
  ];
}
type GradientGeo = { style: string; angle: number; scale: number; reverse?: boolean; dither?: boolean; alignWithLayer?: boolean; offset?: { x: number; y: number }; method?: string };
function gradientGeometryFields(g: GradientGeo, shapeBurst = false): Field[] {
  return [
    { kind: 'check', label: 'Reverse', get: () => !!g.reverse, set: (v) => (g.reverse = v) },
    { kind: 'select', label: 'Style', options: [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond'], ...(shapeBurst ? [['shape-burst', 'Shape Burst'] as [string, string]] : [])], get: () => g.style, set: (v) => (g.style = v) },
    { kind: 'check', label: 'Align with Layer', get: () => g.alignWithLayer !== false, set: (v) => (g.alignWithLayer = v) },
    { kind: 'angle', label: 'Angle', get: () => g.angle, set: (v) => (g.angle = v) },
    pct('Scale', () => g.scale, (v) => (g.scale = Math.max(0.1, v)), 150),
    { kind: 'check', label: 'Dither', get: () => !!g.dither, set: (v) => (g.dither = v) },
    { kind: 'select', label: 'Method', options: [['perceptual', 'Perceptual'], ['linear', 'Linear'], ['classic', 'Classic']], get: () => g.method ?? 'perceptual', set: (v) => (g.method = v) },
    { kind: 'buttons', items: [{ label: 'Reset Alignment', run: () => delete g.offset }] },
  ];
}
function patternPlacementFields(p: { patternId: string; scale: number; angle?: number; linkWithLayer?: boolean; offset?: { x: number; y: number } }): Field[] {
  return [
    { kind: 'pattern', label: 'Pattern', get: () => p.patternId, set: (id) => (p.patternId = id) },
    { kind: 'angle', label: 'Angle', get: () => p.angle ?? 0, set: (v) => (p.angle = v) },
    pct('Scale', () => p.scale, (v) => (p.scale = Math.max(0.01, v)), 1000),
    { kind: 'check', label: 'Link with Layer', get: () => !!p.linkWithLayer, set: (v) => (p.linkWithLayer = v) },
    { kind: 'buttons', items: [{ label: 'Snap to Origin', run: () => delete p.offset }] },
  ];
}
function strokeFields(e: Editor, fx: StrokeFx): Field[] {
  const fill = fx.fill;
  return [
    { kind: 'heading', label: 'Structure' },
    px('Size', () => fx.size, (v) => (fx.size = Math.max(1, v)), 250, 1),
    { kind: 'select', label: 'Position', options: [['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']], get: () => fx.position, set: (v) => (fx.position = v as StrokeFx['position']) },
    { kind: 'blend', label: 'Blend Mode', get: () => fx.blendMode, set: (v) => (fx.blendMode = v) },
    pct('Opacity', () => fx.opacity, (v) => (fx.opacity = v)),
    {
      kind: 'select', label: 'Fill Type', structural: true, options: [['color', 'Color'], ['gradient', 'Gradient'], ['pattern', 'Pattern']], get: () => fx.fill.type,
      set: (v) => {
        if (v === fx.fill.type) return;
        fx.fill = v === 'color' ? { type: 'color', color: [0, 0, 0] }
          : v === 'gradient' ? { type: 'gradient', gradient: resolveGradient(e, gradientPresets[0].gradients[0]), style: 'linear', angle: 90, scale: 1, alignWithLayer: true }
          : { type: 'pattern', patternId: 'checker', scale: 1, linkWithLayer: true };
      },
    },
    ...(fill.type === 'color'
      ? [{ kind: 'color', label: 'Color', get: () => fill.color, set: (v: [number, number, number]) => (fill.color = v) } as Field]
      : fill.type === 'gradient'
        ? [{ kind: 'gradient', label: 'Gradient', get: () => fill.gradient, set: (g) => (fill.gradient = resolveGradient(e, g)) } as Field, ...gradientGeometryFields(fill as GradientGeo, true)]
        : patternPlacementFields(fill)),
  ];
}
const channelTracks: Record<BlendIfChannel, string> = {
  gray: 'linear-gradient(to right, #000, #fff)',
  red: 'linear-gradient(to right, #000, #f00)',
  green: 'linear-gradient(to right, #000, #0f0)',
  blue: 'linear-gradient(to right, #000, #00f)',
};
/** Blending Options: general and advanced blending, Blend If and the light. */
export function blendingFields(
  e: Editor,
  blending: { blend: Layer['blend']; opacity: number; fillOpacity: number },
  adv: AdvancedBlending,
  light: Light,
  ui: { channel: BlendIfChannel },
): Field[] {
  const l = e.layer;
  const exclude = () => (adv.exclude ??= {});
  const channel = () => {
    const ranges = (adv.ranges ??= {});
    return (ranges[ui.channel] ??= openRanges());
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void): Field => ({ kind: 'check', label, get, set });
  return [
    { kind: 'heading', label: 'General Blending' },
    { kind: 'select', label: 'Blend Mode', options: (l?.kind === 'group' ? (['pass through', ...blends] as Layer['blend'][]) : blends).map((b) => [b, blendLabel(b)]), get: () => blending.blend, set: (v) => (blending.blend = v as Layer['blend']) },
    pct('Opacity', () => blending.opacity, (v) => (blending.opacity = v)),
    { kind: 'heading', label: 'Advanced Blending' },
    pct('Fill Opacity', () => blending.fillOpacity, (v) => (blending.fillOpacity = v)),
    {
      kind: 'checks', label: 'Channels', items: (['r', 'g', 'b'] as const).map((k) => ({
        label: k.toUpperCase(), get: () => !adv.exclude?.[k], set: (v: boolean) => (exclude()[k] = !v),
      })),
    },
    { kind: 'select', label: 'Knockout', options: [['none', 'None'], ['shallow', 'Shallow'], ['deep', 'Deep']], get: () => adv.knockout ?? 'none', set: (v) => (adv.knockout = v === 'none' ? undefined : (v as 'shallow')) },
    check('Blend Interior Effects as Group', () => !!adv.interiorAsGroup, (v) => (adv.interiorAsGroup = v)),
    check('Blend Clipped Layers as Group', () => adv.clippedAsGroup !== false, (v) => (adv.clippedAsGroup = v)),
    check('Layer Mask Hides Effects', () => !!adv.maskHidesEffects, (v) => (adv.maskHidesEffects = v)),
    check('Vector Mask Hides Effects', () => !!adv.vectorMaskHidesEffects, (v) => (adv.vectorMaskHidesEffects = v)),
    { kind: 'heading', label: 'Blend If' },
    { kind: 'select', label: 'Channel', structural: true, options: blendIfChannels.map((c) => [c, c[0].toUpperCase() + c.slice(1)]), get: () => ui.channel, set: (v) => (ui.channel = v as BlendIfChannel) },
    { kind: 'range', label: 'This Layer', track: channelTracks[ui.channel], get: () => adv.ranges?.[ui.channel]?.this ?? [0, 0, 255, 255], set: (r) => (channel().this = r) },
    { kind: 'range', label: 'Underlying Layer', track: channelTracks[ui.channel], get: () => adv.ranges?.[ui.channel]?.underlying ?? [0, 0, 255, 255], set: (r) => (channel().underlying = r) },
    { kind: 'buttons', items: [{ label: 'Reset Blend If', run: () => delete adv.ranges }] },
    { kind: 'heading', label: 'Global Light' },
    { kind: 'angle', label: 'Angle', get: () => light.angle, set: (v) => (light.angle = v) },
    { kind: 'slider', label: 'Altitude', min: 0, max: 90, unit: '°', get: () => light.altitude, set: (v) => (light.altitude = v) },
  ];
}
function fieldsFor(e: Editor, style: LayerStyle, s: Section, blending: { blend: Layer['blend']; opacity: number; fillOpacity: number }, adv: AdvancedBlending, light: Light, ui: { channel: BlendIfChannel }): Field[] {
  if (s.key === 'blending') return blendingFields(e, blending, adv, light, ui);
  if (s.key === 'bevel-contour') {
    const c = style.bevel?.contour;
    if (!c) return [];
    return [
      { kind: 'contour', label: 'Contour', get: () => c.contour, set: (x) => (c.contour = x ?? { name: 'Linear', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), aa: { get: () => !!c.antiAliased, set: (v) => (c.antiAliased = v) } },
      pct('Range', () => c.range, (v) => (c.range = v)),
    ];
  }
  if (s.key === 'bevel-texture') {
    const t = style.bevel?.texture;
    if (!t) return [];
    return [
      { kind: 'pattern', label: 'Pattern', get: () => t.patternId, set: (id) => (t.patternId = id) },
      pct('Scale', () => t.scale, (v) => (t.scale = Math.max(0.01, v)), 1000),
      { kind: 'slider', label: 'Depth', min: -1000, max: 1000, unit: '%', display: 100, get: () => t.depth, set: (v) => (t.depth = v) },
      { kind: 'check', label: 'Invert', get: () => !!t.invert, set: (v) => (t.invert = v) },
      { kind: 'check', label: 'Link with Layer', get: () => !!t.linkWithLayer, set: (v) => (t.linkWithLayer = v) },
    ];
  }
  if ('index' in s) {
    const fx = (style[s.key] as unknown[] | undefined)?.[s.index];
    if (!fx) return [];
    if (s.key === 'dropShadow' || s.key === 'innerShadow') return shadowFields(light, fx as ShadowFx, s.key === 'innerShadow');
    if (s.key === 'stroke') return strokeFields(e, fx as StrokeFx);
    if (s.key === 'colorOverlay') {
      const c = fx as import('../../imaging/effects/types').ColorOverlayFx;
      return [
        { kind: 'heading', label: 'Color' },
        { kind: 'blend', label: 'Blend Mode', get: () => c.blendMode, set: (v) => (c.blendMode = v) },
        { kind: 'color', label: 'Color', get: () => c.color, set: (v) => (c.color = v) },
        pct('Opacity', () => c.opacity, (v) => (c.opacity = v)),
      ];
    }
    const g = fx as GradientOverlayFx;
    return [
      { kind: 'heading', label: 'Gradient' },
      { kind: 'blend', label: 'Blend Mode', get: () => g.blendMode, set: (v) => (g.blendMode = v) },
      pct('Opacity', () => g.opacity, (v) => (g.opacity = v)),
      { kind: 'gradient', label: 'Gradient', get: () => g.gradient, set: (x) => (g.gradient = resolveGradient(e, x)) },
      ...gradientGeometryFields(g as GradientGeo),
    ];
  }
  const fx = style[s.key];
  if (!fx) return [];
  if (s.key === 'outerGlow' || s.key === 'innerGlow') return glowFields(e, fx as GlowFx, s.key === 'innerGlow');
  if (s.key === 'bevel') return bevelFields(light, fx as BevelFx);
  if (s.key === 'satin') return satinFields(fx as SatinFx);
  const p = fx as PatternOverlayFx;
  return [
    { kind: 'heading', label: 'Pattern' },
    { kind: 'blend', label: 'Blend Mode', get: () => p.blendMode, set: (v) => (p.blendMode = v) },
    pct('Opacity', () => p.opacity, (v) => (p.opacity = v)),
    ...patternPlacementFields(p),
  ];
}
