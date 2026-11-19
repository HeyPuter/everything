import type { Editor } from '../../editor';
import type { Panel } from '../../app/registry';
import { layerLocked } from '../../model/transform';
import { findLayer, type Layer } from '../../model/document';
import { layerLock, setFullLock, setPartialLock } from '../../model/locks';
import { isVectorGradient } from '../../model/vector-gradient';
import { gradientProperty } from '../../model/gradient-edit';
import { parseStrokeDashInput, supportedStrokePaths } from '../../model/vector-stroke';
import { isVectorPattern } from '../../model/vector-pattern';
import { setVectorColor, vectorHexColor } from '../../color/vector';
import { setPixelMaskLinked } from '../../model/pixel-mask';
import { performAction } from '../../ui/actions';
import { escapeXML } from '../../model/assets';
import { bindFields, rememberFocus, restoreFocus } from './property-fields';
import { documentChange, documentClick, documentKey, documentProperties } from './document-properties';
import { ADJUSTMENTS_MARK, layerClick, layerProperties, multipleProperties } from './layer-properties';

// Adjustment and fill layers provide their own Properties editors.
export type PropertiesEditor = { mount: (e: Editor, el: HTMLElement, l: Layer) => void };
export const propertiesEditors = new Map<string, PropertiesEditor>();
// Extra sections for the selected layer (embedded objects).
export const propertySections: ((e: Editor, l: Layer) => string)[] = [];

let lastHtml = '';
export const propertiesPanel: Panel = {
  id: 'properties',
  title: 'Properties',
  icon: 'sliders-horizontal',
  location: 'dock-middle',
  mount: (e, el) => {
    el.id = 'properties';
    bindFields(e, el);
    el.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (documentClick(e, target) || layerClick(e, target)) return;
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
      // Buttons rendered by the shared property markup map onto workspace commands.
      const mapped: Record<string, string> = { resize: 'image.image-size', transform: 'edit.free-transform', mask: 'layer.add-mask', 'remove-mask': 'layer.mask-delete', 'invert-mask': 'layer.mask-invert', 'toggle-mask': 'layer.mask-toggle', 'edit-text': 'type.edit' };
      if (action && mapped[action]) void e.runCommand(mapped[action]);
      else if (action) void e.run(() => performAction(e, action));
    });
    el.addEventListener('keydown', (ev) => documentKey(e, ev));
    el.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.dataset.filter && e.layer && !layerLocked(e.doc.layers, e.selected)) {
        e.transform.apply();
        const doc = structuredClone(e.doc),
          l = findLayer(doc.layers, e.selected)!;
        l.filters[t.dataset.filter as keyof Layer['filters']] = Number(t.value);
        t.parentElement!.querySelector('output')!.value = t.value;
        e.preview(doc);
      }
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.dataset.pf) void documentChange(e, t);
      else change(e, t);
    });
  },
  update: (e, el) => {
    const display = e.displayDoc;
    const l = findLayer(display.layers, e.selected);
    // Keep focus and in-progress edits stable while dragging sliders.
    if (el.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('input[type=range]')) return;
    const single = l && e.selectedIds.size === 1;
    const custom = single ? propertiesEditors.get(l.artboard ? 'artboard' : l.frame ? 'frame' : l.kind === 'adjustment' ? `adjustment:${l.adjustment?.kind}` : l.fill ? 'fill' : l.kind) : undefined;
    if (custom && l) {
      const key = `${l.id}:${JSON.stringify(l.adjustment ?? l.fill ?? l.artboard ?? l.frame ?? l.color)}:${l.artboard || l.frame ? `${l.name}:${l.children.length}:${l.locked}` : ''}`;
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      lastHtml = '';
      // A fresh host per mount: listeners editors add to it go away with it.
      const host = document.createElement('div');
      host.className = 'pf-host';
      host.dataset.key = key;
      el.replaceChildren(host);
      custom.mount(e, host, l);
      return;
    }
    delete el.dataset.key;
    const locked = l ? layerLocked(e.doc.layers, e.selected) : false;
    let html =
      !l || !e.selectedIds.size
        ? documentProperties(e)
        : e.selectedIds.size > 1
          ? multipleProperties(e, e.selectedIds.size)
          : l.background && l.kind === 'pixel'
            ? documentProperties(e, l)
            : layerProperties(e, display, l, locked) + (l.kind === 'adjustment' ? `<p class="muted">${escapeXML(l.adjustment?.kind ?? '')} adjustment</p>` : '');
    // Feature sections go above the generic adjustment sliders.
    const extra = single ? propertySections.map((f) => f(e, l)).join('') : '';
    if (extra) {
      const at = html.indexOf(ADJUSTMENTS_MARK);
      html = at >= 0 ? html.slice(0, at) + extra + html.slice(at) : html + extra;
    }
    if (html === lastHtml && el.firstElementChild) return;
    lastHtml = html;
    const focus = document.activeElement as HTMLInputElement | null;
    const focusKey = focus && el.contains(focus) ? (focus.dataset.property ?? focus.dataset.filter ?? focus.dataset.pf) : undefined;
    const field = rememberFocus(el);
    const scroll = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = scroll;
    if (field) restoreFocus(el, field);
    else if (focusKey) el.querySelector<HTMLElement>(`[data-property="${focusKey}"],[data-filter="${focusKey}"],[data-pf="${focusKey}"]`)?.focus();
  },
};

function change(e: Editor, t: HTMLInputElement) {
  const k = t.dataset.property;
  if (t.dataset.filter)
    e.editLayer('Adjust ' + t.dataset.filter, (l) => (l.filters[t.dataset.filter as keyof Layer['filters']] = Number(t.value)));
  if (k === 'locked') {
    if (layerLock(e.doc.layers, e.selected, 'all', false)) return;
    e.command('Lock layer', (d) => {
      const l = findLayer(d.layers, e.selected);
      if (l) setFullLock(l, t.checked);
    });
    return;
  }
  if (t.dataset.lock) {
    if (layerLock(e.doc.layers, e.selected, 'all', false)) return;
    const key = t.dataset.lock as keyof NonNullable<Layer['protection']>;
    if (!['transparency', 'composite', 'position', 'artboards'].includes(key)) return;
    e.command('Change layer protection', (d) => {
      const l = findLayer(d.layers, e.selected);
      if (l) setPartialLock(l, key, t.checked);
    });
    return;
  }
  const dashes = k === 'strokeDashes' ? parseStrokeDashInput(t.value) : undefined;
  if (k === 'strokeDashes') {
    t.setCustomValidity(dashes ? '' : 'Enter positive dash lengths and nonnegative gaps, separated by commas.');
    if (!dashes) {
      t.reportValidity();
      return;
    }
    const shape = findLayer(e.doc.layers, e.selected)?.vector;
    if (shape && dashes.length && !supportedStrokePaths(shape.mask, { enabled: true, alignment: shape.stroke?.alignment ?? 'inside', lineDashSet: dashes })) {
      t.setCustomValidity('Dashes are available on a single combined path.');
      t.reportValidity();
      return;
    }
  }
  if (k?.startsWith('gradient') && e.layer && isVectorGradient(e.layer.vector?.fill)) {
    try {
      const fill = gradientProperty(e.layer, e.doc, k, t.value, t.checked);
      t.setCustomValidity('');
      e.editLayer('Change gradient', (l) => {
        l.vector!.fill = fill;
      });
    } catch {
      t.setCustomValidity('Enter a valid gradient value.');
      t.reportValidity();
    }
    return;
  }
  if (!k) return;
  e.editLayer(
    'Change ' + k,
    (l) => {
      if (k === 'name') l.name = t.value;
      else if (k.startsWith('pattern') && isVectorPattern(l.vector?.fill)) {
        const fill = l.vector!.fill;
        if (k === 'patternLinked') fill.align = t.checked;
        else if ((k === 'patternPhaseX' || k === 'patternPhaseY') && Number.isFinite(t.valueAsNumber)) {
          fill.phase ??= { x: 0, y: 0 };
          if (k === 'patternPhaseX') fill.phase.x = t.valueAsNumber;
          else fill.phase.y = t.valueAsNumber;
        }
      } else if (k === 'color') setVectorColor(l, t.value);
      else if (k === 'maskDensity' && l.pixelMask) {
        const density = Number(t.value) / 100;
        if (Number.isFinite(density) && density >= 0 && density <= 1) l.pixelMask.userMaskDensity = density;
      } else if (k === 'maskLinked' && l.pixelMask) setPixelMaskLinked(l, t.checked);
      else if (l.vector && (k.startsWith('stroke') || k === 'fillEnabled')) {
        const s = (l.vector.stroke ??= {
          enabled: false,
          fillEnabled: true,
          lineWidth: { value: 1, units: 'Pixels' },
          lineDashOffset: { value: 0, units: 'Points' },
          resolution: 72,
          cap: 'butt',
          join: 'miter',
          alignment: l.vector.mask.paths.some((p) => p.open) ? 'center' : 'inside',
          miterLimit: 100,
          opacity: 1,
          color: vectorHexColor('#000000'),
        });
        if (k === 'strokeEnabled') s.enabled = t.checked;
        else if (k === 'fillEnabled') s.fillEnabled = t.checked;
        else if (k === 'strokeColor') s.color = vectorHexColor(t.value);
        else if (k === 'strokeAlignment') s.alignment = t.value as typeof s.alignment;
        else if (k === 'strokeCap') s.cap = t.value as typeof s.cap;
        else if (k === 'strokeJoin') s.join = t.value as typeof s.join;
        else if (k === 'strokeDashes') s.lineDashSet = dashes!.length ? dashes : undefined;
        else if (Number.isFinite(Number(t.value))) {
          if (k === 'strokeWidth') s.lineWidth.value = Math.max(0, Number(t.value));
          else if (k === 'strokeOpacity') s.opacity = Math.max(0, Math.min(1, Number(t.value) / 100));
          else if (k === 'strokeMiter') s.miterLimit = Math.max(1, Number(t.value));
          else if (k === 'strokeDashOffset') s.lineDashOffset.value = Number(t.value);
        }
      } else if (k === 'fontSize') l.fontSize = Math.max(1, Math.min(1024, Number(t.value) || 96));
      else {
        const value = Number(t.value);
        if (!Number.isFinite(value)) return;
        l.transform[k as keyof Layer['transform']] = k === 'width' || k === 'height' ? Math.max(1, Math.min(8192, value)) : value;
      }
    },
    ['x', 'y', 'width', 'height', 'rotation'].includes(k) ? 'position' : 'all',
  );
}
