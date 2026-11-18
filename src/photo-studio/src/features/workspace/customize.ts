import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { tools, type Tool } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { toolGroups } from '../../app/toolbar';
import { EXTRA_SLOT, assignTool, slotOrder, slotTools, toolbarLayout, setToolbarLayout, type ToolbarLayout } from '../../app/toolbar-layout';
import { menuSkeleton } from '../../app/menus';
import { resolveMenu, withContributions, type Resolved } from '../../app/menubar';
import { customizeItem, menuCustomization, menuTagColors, setMenuCustomization, type MenuCustomization, type MenuTag } from '../../app/menu-custom';
import { keepFocus } from '../../ui/keep-focus';

// Edit → Toolbar… and Edit → Menus…: dialogs that edit the toolbar layout and
// the menu customization. Changes preview in the dialog and apply on Done.

function dialog(className: string) {
  document.querySelector(`dialog.${className}`)?.remove();
  const d = document.createElement('dialog');
  d.className = className;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  return d;
}

// ----- Toolbar -----
const toolbarTools = () => [...tools.values()].filter((t) => toolGroups.includes(t.group));
export function openToolbarEditor(e: Editor) {
  const d = dialog('toolbar-editor');
  let draft: ToolbarLayout = structuredClone(toolbarLayout());
  const chip = (t: Tool, extra: boolean) =>
    `<div class="tbe-tool" draggable="true" data-tool="${t.id}" title="${escapeXML(t.label)}">${svg(t.icon, 16)}<span>${escapeXML(t.label.replace(/ Tool$/, ''))}</span>${t.key ? `<kbd>${t.key}</kbd>` : ''}<button type="button" class="icon-button tbe-move" data-move-tool="${t.id}" aria-label="${extra ? `Return ${escapeXML(t.label)} to the toolbar` : `Move ${escapeXML(t.label)} to Extra Tools`}" title="${extra ? 'Return to toolbar' : 'Move to Extra Tools'}">${svg(extra ? 'chevrons-left' : 'chevrons-right', 13)}</button></div>`;
  const render = () => {
    const list = toolbarTools();
    const slots = slotOrder(toolGroups, draft)
      .map((g) => {
        const inSlot = slotTools(list, g, draft);
        return `<div class="tbe-slot" data-slot="${g}"><span class="tbe-grip" draggable="true" data-slot-grip="${g}" title="Drag to reorder" aria-hidden="true">${svg('grip-vertical', 14)}</span><div class="tbe-tools" data-drop-slot="${g}">${inSlot.map((t) => chip(t, false)).join('') || '<span class="tbe-empty">Empty slot</span>'}</div><span class="tbe-order"><button type="button" class="icon-button" data-slot-up="${g}" aria-label="Move slot up" title="Move slot up">${svg('arrow-up', 12)}</button><button type="button" class="icon-button" data-slot-down="${g}" aria-label="Move slot down" title="Move slot down">${svg('arrow-down', 12)}</button></span></div>`;
      })
      .join('');
    const extra = slotTools(list, EXTRA_SLOT, draft);
    d.innerHTML = `<form method="dialog"><h2>Customize Toolbar</h2><p>Drag tools between slots, or into Extra Tools to take them off the toolbar. Tools in one slot share a flyout. Extra tools stay available from the last slot of the toolbar and through their keys.</p><div class="tbe-body"><section><h3>Toolbar</h3><div class="tbe-slots">${slots}</div></section><section><h3>Extra Tools</h3><div class="tbe-tools tbe-extra" data-drop-slot="${EXTRA_SLOT}">${extra.map((t) => chip(t, true)).join('') || '<span class="tbe-empty">Drag tools here to hide them from the toolbar.</span>'}</div></section></div><div class="dialog-actions"><button type="button" data-tbe-reset>Restore Defaults</button><span class="panel-tabs-spacer"></span><button type="button" data-tbe-cancel>Cancel</button><button class="primary">Done</button></div></form>`;
  };
  const moveSlot = (g: string, dir: -1 | 1) => {
    const order = slotOrder(toolGroups, draft);
    const i = order.indexOf(g);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    draft = { ...draft, order };
    render();
  };
  // Buttons redraw the dialog: one used from the keyboard keeps the focus
  // (on the same tool or slot in its new place).
  d.addEventListener('click', (ev) => keepFocus(d, () => toolbarClick(ev)));
  const toolbarClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    const move = t.closest<HTMLElement>('[data-move-tool]');
    if (move) {
      const tool = tools.get(move.dataset.moveTool!)!;
      const inExtra = draft.assign?.[tool.id] === EXTRA_SLOT;
      draft = assignTool(draft, tool, inExtra ? tool.group : EXTRA_SLOT);
      render();
      return;
    }
    const up = t.closest<HTMLElement>('[data-slot-up]');
    if (up) return moveSlot(up.dataset.slotUp!, -1);
    const down = t.closest<HTMLElement>('[data-slot-down]');
    if (down) return moveSlot(down.dataset.slotDown!, 1);
    if (t.closest('[data-tbe-reset]')) {
      draft = {};
      render();
    } else if (t.closest('[data-tbe-cancel]')) d.close();
  };
  let dragging: { tool?: string; slot?: string } = {};
  const clear = () => d.querySelectorAll('.drop-target,.drop-above').forEach((n) => n.classList.remove('drop-target', 'drop-above'));
  d.addEventListener('dragstart', (ev) => {
    const t = ev.target as HTMLElement;
    const grip = t.closest<HTMLElement>('[data-slot-grip]');
    const tool = t.closest<HTMLElement>('[data-tool]');
    dragging = grip ? { slot: grip.dataset.slotGrip } : tool ? { tool: tool.dataset.tool } : {};
    ev.dataTransfer?.setData('text/plain', dragging.slot ?? dragging.tool ?? '');
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  d.addEventListener('dragover', (ev) => {
    const t = ev.target as HTMLElement;
    clear();
    if (dragging.tool) {
      const zone = t.closest<HTMLElement>('[data-drop-slot]');
      if (!zone) return;
      ev.preventDefault();
      zone.classList.add('drop-target');
    } else if (dragging.slot) {
      const slot = t.closest<HTMLElement>('.tbe-slot');
      if (!slot) return;
      ev.preventDefault();
      slot.classList.add('drop-above');
    }
  });
  d.addEventListener('drop', (ev) => {
    const t = ev.target as HTMLElement;
    clear();
    ev.preventDefault();
    if (dragging.tool) {
      const zone = t.closest<HTMLElement>('[data-drop-slot]');
      const tool = tools.get(dragging.tool);
      if (zone && tool) draft = assignTool(draft, tool, zone.dataset.dropSlot!);
    } else if (dragging.slot) {
      const slot = t.closest<HTMLElement>('.tbe-slot')?.dataset.slot;
      if (slot && slot !== dragging.slot) {
        const order = slotOrder(toolGroups, draft).filter((g) => g !== dragging.slot);
        order.splice(order.indexOf(slot), 0, dragging.slot);
        draft = { ...draft, order };
      }
    }
    dragging = {};
    render();
  });
  d.addEventListener('dragend', () => {
    dragging = {};
    clear();
  });
  d.addEventListener('submit', (ev) => {
    ev.preventDefault();
    setToolbarLayout(draft);
    e.toolbar.render();
    d.close();
    e.message('Toolbar updated.');
  });
  render();
  d.showModal();
}

// ----- Menus -----
const tagLabels: Record<MenuTag, string> = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', violet: 'Violet', gray: 'Gray' };
export function openMenuEditor(e: Editor) {
  const d = dialog('menu-editor');
  let draft: MenuCustomization = structuredClone(menuCustomization());
  let menu = 0;
  let filter = '';
  const rows = (items: Resolved[], depth: number, q: string): string =>
    items
      .map((item) => {
        if (item.kind === 'separator') return q ? '' : `<div class="me-separator" style="--depth:${depth}" role="separator"></div>`;
        if (item.kind === 'submenu') {
          const inner = rows(item.items, depth + 1, q);
          return inner.replace(/<div class="me-separator[^>]*><\/div>/g, '').trim() ? `<div class="me-row me-submenu" style="--depth:${depth}">${svg('chevron-down', 12)}<span class="me-label">${escapeXML(item.label)}</span></div>${inner}` : '';
        }
        if (q && !item.label.toLowerCase().includes(q)) return '';
        const hidden = !!draft.hidden?.includes(item.id);
        const tag = draft.colors?.[item.id];
        return `<div class="me-row ${hidden ? 'me-hidden' : ''}" style="--depth:${depth}" data-menu-command="${item.id}"><button type="button" class="icon-button me-visibility" data-toggle-visible="${item.id}" aria-pressed="${!hidden}" aria-label="${hidden ? 'Show' : 'Hide'} ${escapeXML(item.label)}" title="${hidden ? 'Hidden — click to show' : 'Visible — click to hide'}">${svg(hidden ? 'eye-off' : 'eye', 14)}</button><span class="me-label ${tag ? `menu-tag-${tag}` : ''}">${escapeXML(item.label)}</span><kbd>${escapeXML(item.shortcut)}</kbd><select data-menu-color="${item.id}" aria-label="Color for ${escapeXML(item.label)}" class="me-color" ${tag ? `data-tag="${tag}"` : ''}><option value="">None</option>${menuTagColors.map((c) => `<option value="${c}" ${tag === c ? 'selected' : ''}>${tagLabels[c]}</option>`).join('')}</select></div>`;
      })
      .join('');
  const render = () => {
    const m = menuSkeleton[menu];
    const items = resolveMenu(e, withContributions(m.id, m.items), m.id);
    const q = filter.trim().toLowerCase();
    d.innerHTML = `<form method="dialog"><h2>Customize Menus</h2><p>Hide commands you never use, or give the ones you look for most a color. Hidden commands keep their keyboard shortcuts and stay in Search.</p><div class="me-head"><div class="segmented me-menus" role="tablist" aria-label="Menus">${menuSkeleton.map((x, i) => `<button type="button" role="tab" data-menu-tab="${i}" aria-pressed="${i === menu}" aria-selected="${i === menu}">${escapeXML(x.label)}</button>`).join('')}</div><input type="search" class="me-filter" placeholder="Filter commands" aria-label="Filter commands" value="${escapeXML(filter)}"></div><div class="me-table" role="list">${rows(items, 0, q) || '<p class="muted">No matching commands.</p>'}</div><div class="dialog-actions"><button type="button" data-me-reset>Restore Defaults</button><span class="me-summary muted">${draft.hidden?.length ?? 0} hidden · ${Object.keys(draft.colors ?? {}).length} colored</span><span class="panel-tabs-spacer"></span><button type="button" data-me-cancel>Cancel</button><button class="primary">Done</button></div></form>`;
  };
  d.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const tab = t.closest<HTMLElement>('[data-menu-tab]');
    if (tab) {
      menu = Number(tab.dataset.menuTab);
      keepFocus(d, render);
      return;
    }
    const vis = t.closest<HTMLElement>('[data-toggle-visible]');
    if (vis) {
      const id = vis.dataset.toggleVisible!;
      draft = customizeItem(draft, id, { hidden: !draft.hidden?.includes(id) });
      render();
      d.querySelector<HTMLElement>(`[data-toggle-visible="${id}"]`)?.focus();
      return;
    }
    if (t.closest('[data-me-reset]')) {
      draft = {};
      keepFocus(d, render);
    } else if (t.closest('[data-me-cancel]')) d.close();
  });
  d.addEventListener('change', (ev) => {
    const t = ev.target as HTMLSelectElement;
    if (!t.dataset.menuColor) return;
    draft = customizeItem(draft, t.dataset.menuColor, { color: (t.value || null) as MenuTag | null });
    render();
    d.querySelector<HTMLElement>(`[data-menu-color="${t.dataset.menuColor}"]`)?.focus();
  });
  d.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (!t.classList.contains('me-filter')) return;
    filter = t.value;
    render();
    const f = d.querySelector<HTMLInputElement>('.me-filter')!;
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
  });
  d.addEventListener('submit', (ev) => {
    ev.preventDefault();
    setMenuCustomization(draft);
    d.close();
    e.message('Menus updated.');
  });
  render();
  d.showModal();
}
