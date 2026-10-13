// Count tool: click to place numbered markers in count groups (each with a
// name, color, marker and label size, and visibility). Drag a marker to move
// it, Alt-click to remove it. Counts are saved with the document.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { registerOverlay, registerTool } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { MAX_COUNTS, type CountGroup } from '../../model/annotations';
import { formDialog } from '../../ui/dialog';
import { annotationsOf, editAnnotations, px, shown } from './state';

// Distinct default colors for new groups.
const palette = ['#ff3b30', '#0a84ff', '#30d158', '#ffd60a', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff375f'];

type Drag = { group: string; index: number; x: number; y: number; moved: boolean };
let drag: Drag | undefined;

// The group new counts go into (a choice of the open document, not an edit).
const active = new WeakMap<DocumentSession, string>();
export const countGroups = (e: Editor) => annotationsOf(e.doc).counts ?? [];
export function activeGroup(e: Editor): CountGroup | undefined {
  const list = countGroups(e);
  return list.find((g) => g.id === active.get(e.session)) ?? list[0];
}
export const totalCount = (e: Editor) => countGroups(e).reduce((s, g) => s + g.points.length, 0);

export function newGroup(groups: CountGroup[], name?: string): CountGroup {
  const n = groups.length + 1;
  return { id: crypto.randomUUID(), name: name ?? `Count Group ${n}`, color: palette[(n - 1) % palette.length], markerSize: 3, labelSize: 10, visible: true, points: [] };
}
function editGroup(e: Editor, label: string, id: string, edit: (g: CountGroup) => void) {
  editAnnotations(e, label, (a) => {
    const g = a.counts?.find((x) => x.id === id);
    if (g) edit(g);
  });
}
export function clearCounts(e: Editor, groupId?: string) {
  editAnnotations(e, 'Clear Count', (a) => {
    for (const g of a.counts ?? []) if (!groupId || g.id === groupId) g.points = [];
  });
}

function hit(e: Editor, x: number, y: number) {
  const tol = px(e, 4);
  let best: { group: string; index: number } | undefined,
    bestD = Infinity;
  for (const g of countGroups(e)) {
    if (!g.visible) continue;
    const r = px(e, g.markerSize * 2 + 2) + tol;
    g.points.forEach(([px0, py0], i) => {
      const d = Math.hypot(px0 - x, py0 - y);
      if (d <= r && d < bestD) {
        best = { group: g.id, index: i };
        bestD = d;
      }
    });
  }
  return best;
}

function overlay(e: Editor) {
  if (!e.hasDocument || !shown(e, 'hideCounts')) return '';
  let html = '';
  for (const g of countGroups(e)) {
    if (!g.visible) continue;
    const r = px(e, g.markerSize * 2),
      w = px(e, 1),
      fs = px(e, g.labelSize);
    g.points.forEach(([x0, y0], i) => {
      const [x, y] = drag && drag.group === g.id && drag.index === i ? [drag.x, drag.y] : [x0, y0];
      html += `<circle cx="${x}" cy="${y}" r="${r}" fill="${g.color}" stroke="#000" stroke-opacity=".55" stroke-width="${w}"/><text x="${x + r + px(e, 2)}" y="${y - r}" font-size="${fs}" fill="${g.color}" stroke="#000" stroke-opacity=".6" stroke-width="${w * 2.5}" paint-order="stroke">${i + 1}</text>`;
    });
  }
  return html ? `<g class="count-markers">${html}</g>` : '';
}

function options(e: Editor) {
  const groups = countGroups(e);
  const g = activeGroup(e);
  const total = totalCount(e);
  const opts = groups.map((x) => `<option value="${escapeXML(x.id)}" ${x.id === g?.id ? 'selected' : ''}>${escapeXML(x.name)} (${x.points.length})</option>`).join('');
  return `<span class="count-total" title="Total of every count group"><b>Count:</b> <output id="count-total">${total}</output></span><span class="divider"></span><label>Group <select id="count-group" aria-label="Count group">${opts || '<option value="">Count Group 1 (0)</option>'}<option value="new">New Group…</option></select></label>${g ? `<button class="icon-button" data-count-action="visible" aria-pressed="${!g.visible}" title="${g.visible ? 'Hide' : 'Show'} this group" aria-label="${g.visible ? 'Hide' : 'Show'} group">${svg(g.visible ? 'eye' : 'eye-off', 15)}</button><button class="icon-button" data-count-action="rename" title="Rename group" aria-label="Rename group">${svg('pen-line', 15)}</button><button class="icon-button" data-count-action="delete" title="Delete group" aria-label="Delete group">${svg('trash-2', 15)}</button>` : ''}<label>Color <input type="color" id="count-color" value="${g?.color ?? palette[0]}"></label><label>Marker <input type="number" id="count-marker" min="1" max="10" step="1" value="${g?.markerSize ?? 3}"></label><label>Label <input type="number" id="count-label" min="8" max="72" step="1" value="${g?.labelSize ?? 10}"></label><button data-count-action="clear" ${g?.points.length ? '' : 'disabled'} title="Remove the counts of this group">Clear</button>`;
}
function bindOptions(e: Editor, el: HTMLElement) {
  const g = activeGroup(e);
  el.querySelector<HTMLSelectElement>('#count-group')?.addEventListener('change', async (ev) => {
    const v = (ev.target as HTMLSelectElement).value;
    if (v === 'new') {
      const r = await formDialog('New Count Group', [{ name: 'name', label: 'Name', value: `Count Group ${countGroups(e).length + 1}` }], 'Create');
      if (!r) {
        e.options();
        return;
      }
      const ng = newGroup(countGroups(e), r.name.trim().slice(0, 128) || undefined);
      active.set(e.session, ng.id);
      editAnnotations(e, 'New Count Group', (a) => (a.counts = [...(a.counts ?? []), ng]));
      return;
    }
    active.set(e.session, v);
    e.options();
  });
  const setNum = (id: string, key: 'markerSize' | 'labelSize', min: number, max: number) =>
    el.querySelector<HTMLInputElement>(id)?.addEventListener('change', (ev) => {
      const v = Math.round(Number((ev.target as HTMLInputElement).value));
      if (!g || !Number.isFinite(v)) return;
      editGroup(e, 'Count Group Options', g.id, (x) => (x[key] = Math.max(min, Math.min(max, v))));
    });
  setNum('#count-marker', 'markerSize', 1, 10);
  setNum('#count-label', 'labelSize', 8, 72);
  el.querySelector<HTMLInputElement>('#count-color')?.addEventListener('change', (ev) => {
    const v = (ev.target as HTMLInputElement).value;
    if (g) editGroup(e, 'Count Group Color', g.id, (x) => (x.color = v));
  });
  el.querySelectorAll<HTMLButtonElement>('[data-count-action]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!g) return;
      const action = b.dataset.countAction;
      if (action === 'visible') editGroup(e, g.visible ? 'Hide Count Group' : 'Show Count Group', g.id, (x) => (x.visible = !x.visible));
      else if (action === 'clear') clearCounts(e, g.id);
      else if (action === 'delete')
        editAnnotations(e, 'Delete Count Group', (a) => (a.counts = (a.counts ?? []).filter((x) => x.id !== g.id)));
      else if (action === 'rename') {
        const r = await formDialog('Rename Count Group', [{ name: 'name', label: 'Name', value: g.name }], 'Rename');
        const name = r?.name.trim().slice(0, 128);
        if (name) editGroup(e, 'Rename Count Group', g.id, (x) => (x.name = name));
      }
    }),
  );
}

export function installCount(_e: Editor) {
  registerOverlay('count-markers', overlay);
  registerTool({
    id: 'count',
    label: 'Count Tool',
    key: 'I',
    icon: 'count',
    group: 'eyedropper',
    cursor: () => 'crosshair',
    options,
    bindOptions: ({ e, el }) => bindOptions(e, el),
    pointerDown: (e, p) => {
      const h = hit(e, p.x, p.y);
      if (h && p.alt) {
        editGroup(e, 'Delete Count', h.group, (g) => g.points.splice(h.index, 1));
        return;
      }
      if (h) {
        const [x, y] = countGroups(e).find((g) => g.id === h.group)!.points[h.index];
        drag = { ...h, x, y, moved: false };
        return;
      }
      if (p.alt || p.x < 0 || p.y < 0 || p.x >= e.doc.width || p.y >= e.doc.height) return;
      if (totalCount(e) >= MAX_COUNTS) {
        e.message(`A document holds up to ${MAX_COUNTS.toLocaleString()} counts.`);
        return;
      }
      const at: [number, number] = [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100];
      const target = activeGroup(e) ?? newGroup([]);
      active.set(e.session, target.id);
      editAnnotations(e, 'Count', (a) => {
        const list = (a.counts ??= []);
        let g = list.find((x) => x.id === target.id);
        if (!g) list.push((g = structuredClone(target)));
        g.visible = true;
        g.points.push(at);
      });
    },
    pointerMove: (e, p) => {
      if (!drag) return;
      drag.x = p.x;
      drag.y = p.y;
      drag.moved = true;
      e.overlay();
    },
    pointerUp: (e) => {
      const d = drag;
      drag = undefined;
      if (!d?.moved) return;
      const inside = d.x >= 0 && d.y >= 0 && d.x < e.doc.width && d.y < e.doc.height;
      editGroup(e, inside ? 'Move Count' : 'Delete Count', d.group, (g) => {
        if (inside) g.points[d.index] = [Math.round(d.x * 100) / 100, Math.round(d.y * 100) / 100];
        else g.points.splice(d.index, 1);
      });
    },
  });
}
