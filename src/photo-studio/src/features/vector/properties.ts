import type { Editor } from '../../editor';
import { findLayer, type Layer } from '../../model/document';
import { properties } from '../../ui/panels';
import { layerLocked } from '../../model/transform';
import { layerLock } from '../../model/locks';
import { svg } from '../../app/icons';
import { propertiesEditors } from '../panels/properties';
import type { LiveShape } from '../../model/live-shape';
import { componentGroups, fitRadii, type PathOp } from './geometry';
import { docLive, reshape, setLive, shapeBounds } from './edit';
import { applyFill, applyStroke, openPaintPopover, specsOf, swatchButton, type FillSpec, type StrokeSpec } from './paint';
import { shapeDocMask, vstate } from './state';

// Properties for shape layers: live shape parameters and geometry in document
// space, fill and stroke paint, and path operations. The generic layer
// properties (locks, gradient/pattern details, stroke options, adjustments and
// masks) follow below, without the generic transform box.
const liveNames: Record<LiveShape['kind'], string> = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', line: 'Line' };
let mounted: { el: HTMLElement; layer: Layer } | undefined;
// Layers whose corner radii are shown separately even while equal (after "unlink").
const unlinked = new Set<string>();

const field = (k: string, label: string, value: number, attrs = '') =>
  `<label class="number-field"><span>${label}</span><input data-vec="${k}" type="number" aria-label="${label}" value="${Math.round(value * 100) / 100}" ${attrs}></label>`;
function liveSection(l: Layer, live: LiveShape | undefined) {
  if (!live) return '';
  if (live.kind === 'rect') {
    const linked = !unlinked.has(l.id) && live.radii.every((r) => r === live.radii[0]);
    return `<h3>Corner radius <button class="icon-button toggle" data-vec-action="link-radii" aria-pressed="${linked}" title="${linked ? 'Edit each corner separately' : 'Use one radius for all corners'}" aria-label="Link corner radii">${svg('link-2', 14)}</button></h3><div class="transform-grid vec-radii-grid">${linked ? field('radius', 'All corners', live.radii[0], 'min="0"') : ['Top left', 'Top right', 'Bottom right', 'Bottom left'].map((c, i) => field(`r${i}`, c, live.radii[i], 'min="0"')).join('')}</div>`;
  }
  if (live.kind === 'triangle') return `<div class="transform-grid">${field('triRadius', 'Corner radius', live.radius, 'min="0"')}</div>`;
  if (live.kind === 'polygon')
    return `<div class="transform-grid">${field('sides', 'Sides', live.sides, 'min="3" max="100" step="1"')}${field('star', 'Star inset (%)', live.star * 100, 'min="0" max="99"')}${field('polyRadius', 'Corner radius', live.radius, 'min="0"')}</div><label class="lock-label"><input type="checkbox" data-vec="smoothIndents" ${live.smoothIndents ? 'checked' : ''}> Smooth star indents</label>`;
  if (live.kind === 'line')
    return `<div class="transform-grid">${field('weight', 'Weight', live.weight, 'min="0.1"')}${field('arrowWidth', 'Arrow width (%)', live.arrowWidth * 100, 'min="100"')}${field('arrowLength', 'Arrow length (%)', live.arrowLength * 100, 'min="10"')}${field('concavity', 'Concavity (%)', live.concavity * 100, 'min="-50" max="50"')}</div><label class="lock-label"><input type="checkbox" data-vec="arrowStart" ${live.arrowStart ? 'checked' : ''}> Arrowhead at start</label><label class="lock-label"><input type="checkbox" data-vec="arrowEnd" ${live.arrowEnd ? 'checked' : ''}> Arrowhead at end</label>`;
  void l;
  return '';
}
function render(e: Editor, el: HTMLElement, l: Layer) {
  const display = e.displayDoc;
  const live = docLive(l);
  const b = shapeBounds(l);
  const { fill, stroke } = specsOf(e, l.vector!);
  const locked = layerLocked(e.doc.layers, l.id);
  const posLocked = !!layerLock(e.doc.layers, l.id, 'position');
  const groups = componentGroups(shapeDocMask(l));
  const st = vstate(e);
  const ops: [PathOp, string, string][] = [['combine', 'Combine Shapes', 'path-op-combine'], ['subtract', 'Subtract Front Shape', 'path-op-subtract'], ['intersect', 'Intersect Shape Areas', 'path-op-intersect'], ['exclude', 'Exclude Overlapping Shapes', 'path-op-exclude']];
  const generic = properties(display, l, 1, locked)
    .replace(/<fieldset [^>]*><h3>Transform<\/h3>[\s\S]*?<\/div><\/fieldset>/, '')
    .replace(/<label class="color-row">Color <input type="color" data-property="color"[^>]*><\/label>/, '');
  el.innerHTML = `<div class="property-body vec-props"><span class="eyebrow">SHAPE LAYER</span><h3>${live ? `Live ${liveNames[live.kind]}` : 'Shape'}${l.vector!.live && !live ? ' <small class="muted">(transformed)</small>' : ''}</h3>
<fieldset ${locked || posLocked ? 'disabled' : ''}><div class="transform-grid">${field('x', 'X', b?.x ?? 0)}${field('y', 'Y', b?.y ?? 0)}${field('width', 'W', b?.width ?? 0, 'min="0"')}${field('height', 'H', b?.height ?? 0, 'min="0"')}<label class="number-field"><span>Angle</span><input data-property="rotation" type="number" aria-label="Angle" value="${Math.round(l.transform.rotation * 100) / 100}" min="-360" max="360"></label></div></fieldset>
<fieldset ${locked ? 'disabled' : ''}>${liveSection(l, live)}
<h3>Appearance</h3><div class="vec-appearance"><span>Fill</span>${swatchButton('vec-prop-fill', 'Fill', fill, e.color)}<span>Stroke</span>${swatchButton('vec-prop-stroke', 'Stroke', stroke, e.color, true)}</div>
<h3>Path operations</h3><p class="muted vec-hint">${groups.length} component${groups.length === 1 ? '' : 's'}${st.paths.size && e.tool === 'path-select' ? ', applies to the selected components' : ', applies to the last component'}</p><div class="vec-ops">${ops.map(([op, label, icon]) => `<button class="icon-button" data-vec-op="${op}" title="${label}" aria-label="${label}">${svg(icon, 16)}</button>`).join('')}<button data-command="path.merge-components" title="Merge overlapping components into one outline">Merge</button></div></fieldset></div>${generic.replace('<div class="property-body">', '<div class="property-body vec-generic">').replace(/<span class="eyebrow">VECTOR LAYER<\/span>/, '')}`;
  bind(e, el, l.id, fill, stroke);
}
function bind(e: Editor, el: HTMLElement, id: string, fill: FillSpec, stroke: StrokeSpec) {
  const edit = (label: string, f: (l: Layer) => void, op: 'all' | 'position' = 'all') => {
    if (e.selected !== id) return;
    e.editLayer(label, f, op);
  };
  el.querySelectorAll<HTMLInputElement>('[data-vec]').forEach((input) =>
    input.addEventListener('change', () => {
      const k = input.dataset.vec!;
      const v = input.type === 'checkbox' ? Number(input.checked) : input.valueAsNumber;
      if (!Number.isFinite(v)) return;
      if (['x', 'y', 'width', 'height'].includes(k)) {
        edit('Resize Shape', (l) => reshape(l, { [k]: k === 'width' || k === 'height' ? Math.max(0, v) : v }), 'position');
        return;
      }
      edit('Change Live Shape', (l) => {
        const live = docLive(l);
        if (!live) return;
        const next = structuredClone(live) as LiveShape & Record<string, unknown>;
        if (next.kind === 'rect') {
          if (k === 'radius') next.radii = [v, v, v, v].map((r) => Math.max(0, r)) as [number, number, number, number];
          else if (/^r[0-3]$/.test(k)) next.radii[Number(k[1])] = Math.max(0, v);
          // Keep the radii the shape can draw, so the fields show the real corners.
          next.radii = fitRadii(next.width, next.height, next.radii);
        } else if (next.kind === 'triangle' && k === 'triRadius') next.radius = Math.max(0, v);
        else if (next.kind === 'polygon') {
          if (k === 'sides') next.sides = Math.round(Math.max(3, Math.min(100, v)));
          if (k === 'star') next.star = Math.max(0, Math.min(0.99, v / 100));
          if (k === 'polyRadius') next.radius = Math.max(0, v);
          if (k === 'smoothIndents') next.smoothIndents = !!v;
        } else if (next.kind === 'line') {
          if (k === 'weight') next.weight = Math.max(0.1, v);
          if (k === 'arrowWidth') next.arrowWidth = Math.max(1, v / 100);
          if (k === 'arrowLength') next.arrowLength = Math.max(0.1, v / 100);
          if (k === 'concavity') next.concavity = Math.max(-0.5, Math.min(0.5, v / 100));
          if (k === 'arrowStart') next.arrowStart = !!v;
          if (k === 'arrowEnd') next.arrowEnd = !!v;
        }
        setLive(l, next);
      });
    }),
  );
  el.querySelector('[data-vec-action="link-radii"]')?.addEventListener('click', (ev) => {
    const l = findLayer(e.doc.layers, id);
    const live = l && docLive(l);
    if (live?.kind !== 'rect') return;
    // Unlinking shows each corner; linking applies the first corner to all.
    if ((ev.currentTarget as HTMLElement).getAttribute('aria-pressed') === 'true') {
      unlinked.add(id);
      render(e, el, l!);
      return;
    }
    unlinked.delete(id);
    const r = live.radii[0];
    if (live.radii.every((v) => v === r)) render(e, el, l!);
    else edit('Change Live Shape', (x) => setLive(x, { ...live, radii: [r, r, r, r] }));
  });
  el.querySelector<HTMLElement>('#vec-prop-fill')?.addEventListener('click', (ev) => {
    let spec = fill;
    openPaintPopover(e, ev.currentTarget as HTMLElement, spec, (s) => {
      spec = s as FillSpec;
      edit('Change Shape Fill', (l) => {
        applyFill(e, l.vector!, spec, shapeBounds(l));
        if (spec.type === 'color') l.color = spec.color || e.color;
      });
    });
  });
  el.querySelector<HTMLElement>('#vec-prop-stroke')?.addEventListener('click', (ev) => {
    let spec = stroke;
    openPaintPopover(e, ev.currentTarget as HTMLElement, spec, (s) => {
      spec = s as StrokeSpec;
      edit('Change Shape Stroke', (l) => applyStroke(l.vector!, spec));
    });
  });
  el.querySelectorAll<HTMLButtonElement>('[data-vec-op]').forEach((b) =>
    b.addEventListener('click', async () => {
      const op = b.dataset.vecOp as PathOp;
      const st = vstate(e);
      if (!(st.paths.size && e.tool === 'path-select')) {
        const l = findLayer(e.doc.layers, id);
        if (!l?.vector) return;
        const groups = componentGroups(shapeDocMask(l));
        st.paths = new Set(groups[groups.length - 1] ?? []);
        st.selectionKey = `layer:${id}`;
      }
      // The path selection tools load on first use.
      await (await import('./select-tools')).setComponentOperation(e, op);
      e.update();
    }),
  );
}

export function installVectorProperties(e: Editor) {
  propertiesEditors.set('vector', {
    mount: (e, el, l) => {
      mounted = { el, layer: l };
      render(e, el, l);
    },
  });
  // The Properties panel remounts editors only on identity changes; refresh
  // whenever the shape layer itself changes (geometry, paint, undo).
  e.onUpdate((e) => {
    const m = mounted;
    if (!m || !m.el.isConnected) return;
    const l = findLayer(e.displayDoc.layers, m.layer.id);
    if (!l || l === m.layer || l.kind !== 'vector' || e.selected !== l.id) return;
    // Always re-render so Undo and committed edits show the stored values, then
    // put focus back on the field the user was in.
    const focused = m.el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const key = focused ? (focused.getAttribute('aria-label') ?? focused.getAttribute('name') ?? focused.id) : null;
    mounted = { el: m.el, layer: l };
    render(e, m.el, l);
    if (key) {
      const again = [...m.el.querySelectorAll<HTMLElement>('input,select,button')].find(
        (x) => (x.getAttribute('aria-label') ?? x.getAttribute('name') ?? x.id) === key,
      );
      again?.focus({ preventScroll: true });
      if (again instanceof HTMLInputElement && again.type === 'text') again.select();
    }
  });
}
