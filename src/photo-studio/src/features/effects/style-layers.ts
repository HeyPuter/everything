import type { Editor } from '../../editor';
import { containerOf, findLayer, layer as newLayer, type Layer } from '../../model/document';
import { gridFromImage } from '../../model/tiles';
import { setLayerPixels } from '../../model/pixel-layer';
import { layerLock } from '../../model/locks';
import { activeLayerStyle, sanitizeStyle } from '../../model/layer-style';
import { documentPatternPixels, stylePatternIds } from '../../model/fill-layer';
import { findPatternPreset } from '../../imaging/pattern/presets';
import type { Pattern } from '../../imaging/pattern/pattern';
import type { LayerStyle } from '../../imaging/effects/types';
import { splitLayerStyle, type StylePiece } from '../../imaging/effects/split';
import { toRGBA8 } from '../pixels';
import { mountFields } from './controls';
import { draggable, effectLabels } from './style-dialog';

// Layer → Layer Style → Create Layers and Global Light.

const partNames = { highlight: 'Highlights', shadow: 'Shadows' };
function pieceName(layerName: string, p: StylePiece, counts: Map<string, number>) {
  const label = effectLabels[p.effect] ?? p.effect;
  const base = `${layerName}’s ${label}${p.part ? ` ${partNames[p.part]}` : ''}`;
  const n = (counts.get(base) ?? 0) + 1;
  counts.set(base, n);
  return n > 1 ? `${base} ${n}` : base;
}
const layerBlend = (mode: string) => mode.replace(/-/g, ' ') as Layer['blend'];

/** Replaces the selected layer's effects by pixel layers that approximate
 * them: shadows and glows below the layer, interior effects clipped to it,
 * outer strokes and bevels above. */
export async function createStyleLayers(e: Editor) {
  const l = e.layer;
  const raw = l && activeLayerStyle(l);
  if (!l || !raw) return;
  if (layerLock(e.doc.layers, l.id, 'all')) {
    e.message('Unlock this layer to create layers from its effects.');
    return;
  }
  if (l.clipped) {
    e.message('Release the clipping mask first: the effects of a clipped layer cannot be clipped again.');
    return;
  }
  const doc = e.doc;
  const style: LayerStyle = sanitizeStyle(raw);
  if (doc.globalLight) {
    style.globalAngle = doc.globalLight.angle;
    style.globalAltitude = doc.globalLight.altitude;
  }
  // The effects are drawn from the layer's own pixels (masks applied, no fill).
  const samples = await e.renderer.layerPixels({ ...l, style: undefined, fillOpacity: 1 }, doc, e.assets);
  const input = toRGBA8(samples, doc.width, doc.height);
  const own = new Map<string, Pattern>();
  for (const id of stylePatternIds(style)) {
    const p = doc.patterns?.find((x) => x.id === id);
    const pixels = p && documentPatternPixels(p, e.assets.tiles);
    if (pixels) own.set(id, pixels);
  }
  const pieces = splitLayerStyle(input, style, { patterns: (id) => own.get(id) ?? findPatternPreset(id) });
  if (!pieces.length) {
    e.message('The effects of this layer do not draw anything.');
    return;
  }
  const counts = new Map<string, number>();
  const made = pieces.map((p) => {
    const x = newLayer('pixel', pieceName(l.name, p, counts), doc.width, doc.height);
    x.blend = layerBlend(p.mode);
    x.opacity = l.opacity;
    x.visible = l.visible;
    if (p.stage === 'interior') x.clipped = true;
    return { layer: x, grid: gridFromImage(e.assets.tiles, p.image, p.rect.x, p.rect.y), stage: p.stage };
  });
  const id = l.id;
  e.command('Create Layers', (d) => {
    const list = containerOf(d.layers, id);
    const t = findLayer(d.layers, id);
    if (!list || !t) return;
    for (const m of made) setLayerPixels(m.layer, m.grid, d);
    delete t.style;
    const at = list.indexOf(t);
    const below = made.filter((m) => m.stage === 'below').map((m) => m.layer);
    // Clipped layers must sit directly above their base.
    const above = [...made.filter((m) => m.stage === 'interior'), ...made.filter((m) => m.stage === 'above')].map((m) => m.layer);
    list.splice(at + 1, 0, ...above);
    list.splice(at, 0, ...below);
  });
  e.message(`Created ${made.length} layer${made.length === 1 ? '' : 's'} from the layer’s effects.`);
}

let lightOpen = false;
/** Document-wide light angle and altitude for effects that use the global light. */
export function globalLightDialog(e: Editor) {
  if (lightOpen) return;
  lightOpen = true;
  const original = e.doc;
  const light = { angle: original.globalLight?.angle ?? 120, altitude: original.globalLight?.altitude ?? 30 };
  const dialog = document.createElement('dialog');
  dialog.className = 'layer-style-dialog global-light-dialog';
  dialog.setAttribute('aria-label', 'Global Light');
  dialog.innerHTML = `<form method="dialog" novalidate><h2>Global Light</h2><p class="muted">Shadows, bevels and other effects set to use the global light share this direction.</p><div class="ls-fields"></div><div class="dialog-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
  e.root.append(dialog);
  const preview = () => e.preview({ ...original, globalLight: { ...light } });
  mountFields(e, dialog.querySelector<HTMLElement>('.ls-fields')!, () => [
    { kind: 'angle', label: 'Angle', get: () => light.angle, set: (v) => (light.angle = v) },
    { kind: 'slider', label: 'Altitude', min: 0, max: 90, unit: '°', get: () => light.altitude, set: (v) => (light.altitude = v) },
  ], () => preview());
  const close = (commit: boolean) => {
    dialog.close();
    dialog.remove();
    lightOpen = false;
    if (!commit) {
      e.preview(e.doc);
      return;
    }
    e.command('Global Light', (d) => {
      d.globalLight = { angle: Math.round(light.angle), altitude: Math.round(light.altitude) };
    });
  };
  dialog.querySelector('form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    close(true);
  });
  dialog.querySelector('[data-cancel]')!.addEventListener('click', () => close(false));
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    close(false);
  });
  dialog.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('input[type=number]')) {
      ev.preventDefault();
      (ev.target as HTMLElement).dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  dialog.showModal();
  draggable(dialog);
}
