import type { Editor } from '../editor';
import { findLayer } from '../model/document';
import { assertEditable, moveLayers, type DropPosition } from '../model/layers';

export function bindLayerDrag(e: Editor, panel: HTMLElement = e.el('.layers-panel')) {
  const scroll = panel.querySelector<HTMLElement>('#layers')!;
  let dragging: Set<string> | undefined;
  let pending: { id: string | null; position: DropPosition } | undefined;
  const clear = () =>
    panel.querySelectorAll('[data-drop]').forEach((row) => row.removeAttribute('data-drop'));
  const destination = (event: DragEvent) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-row]');
    if (!row && !(event.target as Element).closest('#layers,.layer-root-drop')) return;
    if (!row)
      return {
        id: null,
        position: 'above' as DropPosition,
        element: panel.querySelector<HTMLElement>('.layer-root-drop'),
      };
    const rect = row.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;
    const id = row.dataset.row!;
    const l = findLayer(e.doc.layers, id);
    const group = l?.kind === 'group';
    let position: DropPosition =
      group && fraction >= 0.25 && fraction <= 0.75 ? 'inside' : fraction < 0.5 ? 'above' : 'below';
    // Under an expanded group's row come its own layers: a drop there goes
    // into the group, at the top, rather than below the whole group.
    if (position === 'below' && group && l.children.length && !e.collapsedGroups.has(id))
      position = 'inside';
    return { id, position, element: row };
  };
  panel.addEventListener('dragstart', (event) => {
    const id = (event.target as Element).closest<HTMLElement>('[data-row]')?.dataset.row;
    if (!id || e.busy || e.transform.active) {
      event.preventDefault();
      return;
    }
    if (!e.selectedIds.has(id)) e.selectLayers([id]);
    try {
      assertEditable(e.doc, e.selectedLayers);
    } catch (error) {
      e.message((error as Error).message);
      event.preventDefault();
      return;
    }
    dragging = new Set(e.selectedIds);
    panel
      .querySelectorAll<HTMLElement>('[data-row]')
      .forEach((row) => row.classList.toggle('selected', dragging!.has(row.dataset.row!)));
    event.dataTransfer!.effectAllowed = 'move';
    event.dataTransfer!.setData('application/x-photo-layers', [...dragging].join(','));
    panel.classList.add('layers-dragging');
  });
  panel.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();
    clear();
    pending = undefined;
    const target = destination(event);
    if (!target) return;
    try {
      // Validate on a copy so invalid drops cannot partially mutate the document.
      moveLayers(structuredClone(e.doc), dragging, target.id, target.position);
      target.element?.setAttribute('data-drop', target.position);
      pending = { id: target.id, position: target.position };
      event.dataTransfer!.dropEffect = 'move';
    } catch {
      event.dataTransfer!.dropEffect = 'none';
    }
    const rect = scroll.getBoundingClientRect();
    if (event.clientY < rect.top + 28) scroll.scrollTop -= 16;
    if (event.clientY > rect.bottom - 28) scroll.scrollTop += 16;
  });
  panel.addEventListener('drop', (event) => {
    if (!dragging) return;
    event.preventDefault();
    const ids = dragging,
      target = pending;
    dragging = undefined;
    clear();
    panel.classList.remove('layers-dragging');
    pending = undefined;
    if (!target) return;
    void e.run(async () => {
      e.command('Move layers', (doc) => moveLayers(doc, ids, target.id, target.position));
      if (target.id && target.position === 'inside') e.collapsedGroups.delete(target.id);
      e.selectLayers([...ids]);
      e.update();
    });
  });
  panel.addEventListener('dragend', () => {
    dragging = undefined;
    pending = undefined;
    clear();
    panel.classList.remove('layers-dragging');
    e.update();
  });
}
