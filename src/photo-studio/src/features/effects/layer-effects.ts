import type { Editor } from '../../editor';
import { findLayer, type Layer } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import type { LayerStyle } from '../../imaging/effects/types';
import { gradientToCss } from '../../imaging/gradient/edit';
import { findPatternPreset } from '../../imaging/pattern/presets';
import { effectLabels } from './effect-order';
import { patternThumb } from './state';

// Layers panel integration: the fx badge, the list of a layer's effects
// with visibility toggles (double-click opens the effect in the Layer Style
// dialog) and swatches for gradient/pattern fill layers.
const collapsed = new Set<string>();
const multi = ['dropShadow', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'stroke'] as const;
const single = ['outerGlow', 'innerGlow', 'bevel', 'satin', 'patternOverlay'] as const;
// Layers panel order (top to bottom), as in the dialog.
const listOrder = ['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
export function styleEffects(style: LayerStyle | undefined): { key: string; index?: number; label: string; enabled: boolean }[] {
  if (!style) return [];
  const out: { key: string; index?: number; label: string; enabled: boolean }[] = [];
  for (const key of listOrder) {
    if ((multi as readonly string[]).includes(key))
      ((style as Record<string, unknown>)[key] as { enabled: boolean }[] | undefined)?.forEach((fx, index) => out.push({ key, index, label: effectLabels[key], enabled: fx.enabled }));
    else if ((single as readonly string[]).includes(key)) {
      const fx = (style as Record<string, unknown>)[key] as { enabled: boolean } | undefined;
      if (fx) out.push({ key, label: effectLabels[key], enabled: fx.enabled });
    }
  }
  return out;
}
export function fxBadge(l: Layer) {
  const fx = styleEffects(l.style as LayerStyle | undefined);
  if (!fx.length) return '';
  const open = !collapsed.has(l.id);
  const off = (l.style as LayerStyle).enabled === false;
  return `<button class="fx-badge ${off ? 'fx-off' : ''}" data-fx-collapse="${escapeXML(l.id)}" title="Layer style — click to ${open ? 'hide' : 'show'} effects, double-click to edit" aria-label="Layer effects" aria-expanded="${open}">fx${svg(open ? 'chevron-down' : 'chevron-right', 10)}</button>`;
}
export function effectRows(l: Layer, depth: number) {
  const fx = styleEffects(l.style as LayerStyle | undefined);
  if (!fx.length || collapsed.has(l.id)) return '';
  const all = (l.style as LayerStyle).enabled !== false;
  const row = (sel: string, label: string, on: boolean, cls = '') =>
    `<div class="fx-item ${cls} ${on ? '' : 'fx-hidden'}" data-fx-open="${sel}" style="--depth:${depth}"><button class="eye" data-fx-eye="${sel}" title="${on ? 'Hide' : 'Show'} ${escapeXML(label)}" aria-label="${on ? 'Hide' : 'Show'} ${escapeXML(label)}">${on ? svg('eye', 13) : ''}</button><span>${escapeXML(label)}</span></div>`;
  return `<div class="fx-list" role="group" aria-label="Effects of ${escapeXML(l.name)}">${row(`${l.id}|all`, 'Effects', all, 'fx-head')}${fx.map((f) => row(`${l.id}|${f.key}${f.index !== undefined ? ':' + f.index : ''}`, f.label, f.enabled && all)).join('')}</div>`;
}
export function fillThumb(l: Layer): string | undefined {
  const f = l.fill;
  if (!f) return undefined;
  if (f.type === 'gradient') return `<span class="swatch-thumb" style="background:${gradientToCss(f.gradient, {}, 90 - f.angle)}"></span>`;
  const p = findPatternPreset(f.patternId);
  return p ? `<span class="swatch-thumb" style="background:url(${patternThumb(p, 24)})"></span>` : `<span class="swatch-thumb"></span>`;
}
export function bindLayerEffects(e: Editor) {
  e.root.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const collapse = t.closest<HTMLElement>('[data-fx-collapse]')?.dataset.fxCollapse;
    if (collapse) {
      ev.stopPropagation();
      if (collapsed.has(collapse)) collapsed.delete(collapse);
      else collapsed.add(collapse);
      e.dock.update();
      return;
    }
    const eye = t.closest<HTMLElement>('[data-fx-eye]')?.dataset.fxEye;
    if (!eye) return;
    ev.stopPropagation();
    const [id, sel] = eye.split('|');
    e.command('Toggle Effect Visibility', (d) => {
      const l = findLayer(d.layers, id);
      const s = l?.style as LayerStyle | undefined;
      if (!s) return;
      if (sel === 'all') {
        s.enabled = s.enabled === false;
        return;
      }
      const [key, i] = sel.split(':');
      const fx = (i !== undefined ? ((s as Record<string, unknown>)[key] as { enabled: boolean }[])?.[Number(i)] : (s as Record<string, unknown>)[key]) as { enabled: boolean } | undefined;
      if (fx) fx.enabled = !fx.enabled;
      // Showing one effect of a hidden style shows the style.
      if (fx?.enabled) s.enabled = true;
    });
  }, true);
  e.root.addEventListener('dblclick', (ev) => {
    const t = ev.target as HTMLElement;
    const open = t.closest<HTMLElement>('[data-fx-open]')?.dataset.fxOpen ?? (t.closest('[data-fx-collapse]') ? `${t.closest<HTMLElement>('[data-fx-collapse]')!.dataset.fxCollapse}|` : undefined);
    if (!open || t.closest('[data-fx-eye]')) return;
    ev.stopPropagation();
    const [id, sel] = open.split('|');
    e.selectLayer(id);
    void e.runCommand('layer.style-dialog', sel && sel !== 'all' ? sel : '');
  }, true);
}
