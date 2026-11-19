// Relight layers: Layer › New Relight Layer, the light handles drawn over the
// canvas while a relight layer is selected (drag to move, arrow keys nudge,
// N hides them) and View › Show › Relight Lights. The layer itself is an
// adjustment layer of kind 'relight' (see features/adjust and
// imaging/relight); its Properties editor lives in adjust/relight-editor.ts.
import type { Editor } from '../../editor';
import { registerCommand, registerOverlay } from '../../app/registry';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock } from '../../model/locks';
import { escapeXML } from '../../model/assets';
import { adjustmentSpec } from '../adjust/spec';
import { addAdjustmentLayer } from '../adjust/layers';
import { lightCss, prepareLights, type RelightParams } from '../../imaging/relight/model';
import { activeRelightLayer, relightParams, relightUi, selectedLight, selectLight } from './state';
import './relight.css';

export { relightUi } from './state';

/** Listeners told when the selected light or the handle visibility changes
 * (the Properties editor highlights the selected light). */
export const relightListeners = new Set<() => void>();
export const notifyRelight = () => relightListeners.forEach((f) => f());

function replaceLayer(layers: Layer[], id: string, fn: (l: Layer) => Layer): Layer[] {
  return layers.map((l) =>
    l.id === id
      ? fn(l)
      : l.children.length
        ? { ...l, children: replaceLayer(l.children, id, fn) }
        : l,
  );
}
/** The document with a relight layer's settings replaced (for previews). */
export function withRelight(doc: PhotoDocument, id: string, params: RelightParams): PhotoDocument {
  const spec = adjustmentSpec({ kind: 'relight', params });
  return { ...doc, layers: replaceLayer(doc.layers, id, (l) => ({ ...l, adjustment: spec })) };
}

/** Store new settings for a relight layer as one history step. */
export function commitRelight(e: Editor, id: string, params: RelightParams, label: string) {
  if (layerLock(e.doc.layers, id, 'all')) {
    e.message('Unlock this layer to edit it.');
    e.update();
    return false;
  }
  const spec = adjustmentSpec({ kind: 'relight', params });
  e.command(label, (d) => {
    const t = findLayer(d.layers, id);
    if (t) t.adjustment = spec;
  });
  return true;
}

function drawHandles(e: Editor) {
  const l = activeRelightLayer(e);
  if (!l || relightUi.hidden) return '';
  const p = relightUi.draft?.layerId === l.id ? relightUi.draft.params : relightParams(l);
  const W = e.doc.width,
    H = e.doc.height,
    z = Math.max(1e-6, e.zoom);
  const sel = selectedLight(l.id, p);
  const reach = new Map(
    prepareLights(p, W, H).map((pl, i) => [
      p.lights.filter((x) => x.visible && x.brightness > 0)[i]?.id,
      pl.reach,
    ]),
  );
  let html = '<g class="relight-handles">';
  for (const light of p.lights) {
    const cx = light.x * W,
      cy = light.y * H;
    const on = light.id === sel?.id;
    const r = reach.get(light.id);
    if (on && r)
      html += `<circle class="relight-reach" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${1 / z}" stroke-dasharray="${6 / z} ${5 / z}"/>`;
    const label = `${light.name}${light.visible ? '' : ' (hidden)'}: drag to move`;
    html += `<g class="relight-handle canvas-ui${on ? ' selected' : ''}${light.visible ? '' : ' off'}" data-relight-light="${escapeXML(light.id)}"><title>${escapeXML(label)}</title>`;
    html += `<circle class="relight-halo" cx="${cx}" cy="${cy}" r="${(on ? 15 : 12) / z}" stroke-width="${(on ? 2.5 : 1.5) / z}"/>`;
    html += `<circle class="relight-dot" cx="${cx}" cy="${cy}" r="${8 / z}" fill="${lightCss(light)}" stroke-width="${1.5 / z}"/></g>`;
  }
  return html + '</g>';
}

const clampPos = (v: number) => Math.min(1.5, Math.max(-0.5, v));

function startDrag(e: Editor, l: Layer, lightId: string, ev: PointerEvent) {
  const base = relightParams(l);
  const light = base.lights.find((x) => x.id === lightId);
  if (!light) return;
  const W = e.doc.width,
    H = e.doc.height;
  const before = e.doc;
  const [sx, sy] = e.docPoint(ev.clientX, ev.clientY);
  const offset = [light.x * W - sx, light.y * H - sy];
  let moved = false;
  const at = (m: PointerEvent): RelightParams => {
    const [px, py] = e.docPoint(m.clientX, m.clientY);
    let x = px + offset[0],
      y = py + offset[1];
    // Shift keeps the light on a horizontal or vertical line.
    if (m.shiftKey) {
      if (Math.abs(px - sx) > Math.abs(py - sy)) y = light.y * H;
      else x = light.x * W;
    }
    return {
      ...base,
      lights: base.lights.map((o) =>
        o.id === lightId ? { ...o, x: clampPos(x / W), y: clampPos(y / H) } : o,
      ),
    };
  };
  const move = (m: PointerEvent) => {
    if (m.pointerId !== ev.pointerId) return;
    if (!moved && Math.hypot(m.clientX - ev.clientX, m.clientY - ev.clientY) < 2) return;
    moved = true;
    const params = at(m);
    relightUi.draft = { layerId: l.id, params };
    e.preview(withRelight(before, l.id, params));
    e.overlay();
  };
  const up = (u: PointerEvent) => {
    if (u.pointerId !== ev.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    const params = moved && u.type === 'pointerup' ? at(u) : undefined;
    relightUi.draft = undefined;
    e.toolBusy = false;
    // One history step per drag; a click only selects the light.
    if (params && e.doc === before) commitRelight(e, l.id, params, 'Move Light');
    else e.update();
  };
  e.toolBusy = true;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function bindCanvas(e: Editor) {
  const viewport = e.el('#viewport');
  viewport.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.button !== 0 || e.busy) return;
      const handle = (ev.target as Element).closest?.('[data-relight-light]');
      if (!handle) return;
      const l = activeRelightLayer(e);
      if (!l) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      viewport.focus({ preventScroll: true });
      const lightId = handle.getAttribute('data-relight-light')!;
      selectLight(l.id, lightId);
      notifyRelight();
      e.overlay();
      if (layerLock(e.doc.layers, l.id, 'all')) return e.message('Unlock this layer to edit it.');
      startDrag(e, l, lightId, ev);
    },
    true,
  );
}

function modalOpen() {
  try {
    return !!document.querySelector('dialog:modal');
  } catch {
    return !!document.querySelector('dialog[open]');
  }
}

export function toggleHandles(e: Editor) {
  relightUi.hidden = !relightUi.hidden;
  e.overlay();
  notifyRelight();
}

/** Nudge the selected light by (dx, dy) document pixels. */
export function nudgeLight(e: Editor, dx: number, dy: number) {
  const l = activeRelightLayer(e);
  if (!l) return false;
  const p = relightParams(l);
  const light = selectedLight(l.id, p);
  if (!light) return false;
  const next = {
    ...p,
    lights: p.lights.map((o) =>
      o.id === light.id
        ? { ...o, x: clampPos(o.x + dx / e.doc.width), y: clampPos(o.y + dy / e.doc.height) }
        : o,
    ),
  };
  commitRelight(e, l.id, next, 'Nudge Light');
  return true;
}

function bindKeys(e: Editor) {
  // Capture phase: these keys mean something else elsewhere (N has no
  // command; arrows nudge layers with the Move tool), so they are taken only
  // while a relight layer is the selected layer.
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const target = ev.target as HTMLElement;
      if (
        target.closest?.(
          'input,textarea,select,[contenteditable="true"],[role="slider"],dialog,.menubar,puter-user-menu',
        )
      )
        return;
      if (modalOpen() || e.busy || e.toolBusy || e.transform.active || e.transform.dragging) return;
      // Keys typed into panels (lists, buttons) stay there.
      if (target !== document.body && !target.closest('#viewport,#stage')) return;
      if (!activeRelightLayer(e)) return;
      if (ev.key === 'n' || ev.key === 'N') {
        if (ev.shiftKey || ev.repeat) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        toggleHandles(e);
        return;
      }
      if (!ev.key.startsWith('Arrow') || relightUi.hidden) return;
      // With a selection and a tool other than Move, arrows keep nudging the selection outline.
      if (e.doc.selection && e.tool !== 'move') return;
      const step = ev.shiftKey ? 10 : 1;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0,
        dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      if (nudgeLight(e, dx, dy)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    },
    true,
  );
}

export function installRelight(e: Editor) {
  registerCommand(
    {
      id: 'layer.new-relight',
      label: 'New Relight Layer',
      description:
        'Add a layer that relights the image below it with lights you place and drag on the canvas',
      enabled: (ed) => ed.hasDocument,
      run: (ed) => void addAdjustmentLayer(ed, 'relight'),
    },
    {
      id: 'view.show-relight-lights',
      label: 'Relight Lights',
      description:
        'Show or hide the light handles of the selected relight layer (N while it is selected)',
      enabled: (ed) => ed.hasDocument,
      checked: () => !relightUi.hidden,
      recordable: false,
      run: (ed) => toggleHandles(ed),
    },
  );
  registerOverlay('relight', drawHandles);
  bindCanvas(e);
  bindKeys(e);
}
