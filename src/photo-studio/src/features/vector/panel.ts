import type { Editor } from '../../editor';
import { commands, type Panel } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { formDialog } from '../../ui/dialog';
import { maskToSvg } from './geometry';
import { activeKey, listedPaths, nextPathName, setActive, targetPath, type PathTarget } from './state';

// Paths panel: the selected shape layer's path and vector mask, the work path
// and saved document paths, with the classic footer actions.
function thumb(e: Editor, t: PathTarget) {
  const W = e.doc.width, H = e.doc.height;
  const d = maskToSvg(t.mask);
  return `<svg class="path-thumb" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><rect width="${W}" height="${H}" class="path-thumb-bg"/><path d="${d}" fill-rule="${t.mask.paths[0]?.fillRule === 'even-odd' ? 'evenodd' : 'nonzero'}" class="path-thumb-fill"/></svg>`;
}
export async function savePathDialog(e: Editor, t: PathTarget) {
  if (t.kind === 'saved') {
    const v = await formDialog('Rename Path', [{ name: 'name', label: 'Name', value: t.name }], 'OK');
    if (v?.name) e.command('Rename Path', (d) => (d.paths!.find((p) => p.id === t.id)!.name = v.name));
    return;
  }
  const name = nextPathName(e.doc);
  const v = await formDialog('Save Path', [{ name: 'name', label: 'Name', value: name }], 'OK');
  if (!v) return;
  const id = crypto.randomUUID();
  e.command('Save Path', (d) => {
    d.paths = [...(d.paths ?? []), { id, name: v.name || name, mask: structuredClone(t.mask) }];
    if (t.kind === 'work') delete d.workPath;
  });
  setActive(e, `path:${id}`);
  e.update();
}
export const pathsPanel: Panel = {
  id: 'paths',
  title: 'Paths',
  icon: 'path-panel',
  location: 'dock-bottom',
  mount: (e, el) => {
    el.classList.add('paths-panel');
    el.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('[data-command]')) return;
      const row = target.closest<HTMLElement>('[data-path-key]');
      if (!row) {
        if (target.closest('.path-list')) {
          // Clicking empty space deselects the path (hides it).
          setActive(e, 'none');
          e.update();
        }
        return;
      }
      const key = row.dataset.pathKey!;
      setActive(e, key.startsWith('layer:') ? undefined : key);
      e.update();
      // Mod-click (or a click on the thumbnail with Mod) loads the path as a selection.
      if (ev.metaKey || ev.ctrlKey) void e.runCommand('path.make-selection');
    });
    el.addEventListener('dblclick', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-path-key]');
      if (!row) return;
      const t = listedPaths(e).find((p) => activeKey(p) === row.dataset.pathKey);
      if (t && (t.kind === 'work' || t.kind === 'saved')) void savePathDialog(e, t);
    });
    el.addEventListener('keydown', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-path-key]');
      if (!row) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        row.click();
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const rows = [...el.querySelectorAll<HTMLElement>('[data-path-key]')];
        rows[(rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
      }
    });
  },
  update: (e, el) => {
    const list = listedPaths(e);
    const active = targetPath(e);
    const activeK = active ? activeKey(active) : '';
    const rows = list
      .map((t) => {
        const key = activeKey(t);
        const italic = t.kind !== 'saved';
        return `<div class="path-row ${key === activeK ? 'selected' : ''}" data-path-key="${escapeXML(key)}" role="option" tabindex="0" aria-selected="${key === activeK}" title="${t.kind === 'work' ? 'Double-click to save the work path' : t.kind === 'saved' ? 'Double-click to rename' : ''}">${thumb(e, t)}<span class="path-name">${italic ? `<i>${escapeXML(t.name)}</i>` : escapeXML(t.name)}</span></div>`;
      })
      .join('');
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('[data-path-key]')?.getAttribute('data-path-key');
    el.innerHTML = `<div class="path-list" role="listbox" aria-label="Paths">${rows || '<p class="muted path-empty">No paths. Draw with the Pen or a shape tool in Path mode.</p>'}</div><div class="layer-footer"><button data-command="path.fill" title="Fill path with foreground color" aria-label="Fill path with foreground color">${svg('path-fill', 16)}</button><button data-command="path.stroke" title="Stroke path with brush" aria-label="Stroke path with brush">${svg('path-stroke', 16)}</button><button data-command="path.make-selection" title="Load path as a selection" aria-label="Load path as a selection">${svg('circle-dashed', 16)}</button><button data-command="path.from-selection" title="Make work path from selection" aria-label="Make work path from selection">${svg('path-from-selection', 16)}</button><button data-command="layer.vmask-current-path" title="Add vector mask" aria-label="Add vector mask">${svg('mask-add', 16)}</button><button data-command="path.new" title="Create new path" aria-label="Create new path">${svg('plus', 16)}</button><button data-command="path.delete" title="Delete path" aria-label="Delete path">${svg('trash-2', 16)}</button></div>`;
    if (focused) el.querySelector<HTMLElement>(`[data-path-key="${CSS.escape(focused)}"]`)?.focus();
    for (const b of el.querySelectorAll<HTMLButtonElement>('.layer-footer [data-command]')) {
      const id = b.dataset.command!;
      b.disabled = !commandEnabled(e, id);
    }
  },
  menu: () => ['path.new', 'path.save', 'path.duplicate', 'path.delete', '-', 'path.from-selection-dialog', 'path.make-selection-dialog', 'path.fill-dialog', 'path.stroke-dialog', '-', 'layer.vmask-current-path', 'edit.define-shape'],
};
function commandEnabled(e: Editor, id: string) {
  const c = commands.get(id);
  return !!c && (c.enabled?.(e) ?? true);
}
