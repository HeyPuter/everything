import type { Editor } from '../editor';
import { escapeXML } from '../model/assets';
import { svg } from './icons';
import { toolTitle } from './option-tips';
import { tools, type Tool } from './registry';
import { showContextMenu } from './menubar';
import { EXTRA_SLOT, slotOrder, slotTools, toolSlot, toolbarLayout } from './toolbar-layout';

// Toolbar slots in display order; tools register into a slot by group.
export const toolGroups = [
  'move', 'marquee', 'lasso', 'select', 'crop', 'frame', 'eyedropper', 'heal', 'brush', 'stamp',
  'history-brush', 'eraser', 'fill', 'focus', 'tone', 'pen', 'type', 'path-select', 'shape', 'hand', 'zoom',
];
// Separators between families of slots.
const separatorsBefore = new Set(['crop', 'heal', 'pen', 'hand']);

/** Tools shown in a slot, after toolbar customization (Edit → Toolbar). */
export function groupTools(group: string): Tool[] {
  return slotTools([...tools.values()], group, toolbarLayout());
}

export class Toolbar {
  // Last used tool of each group is the one shown in its slot.
  private current = new Map<string, string>();
  constructor(
    private e: Editor,
    private el: HTMLElement,
  ) {
    el.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      const flyoutItem = target.closest<HTMLElement>('[data-flyout-tool]');
      if (flyoutItem) {
        this.closeFlyout();
        e.setTool(flyoutItem.dataset.flyoutTool!);
        return;
      }
      const slot = target.closest<HTMLElement>('[data-slot]');
      if (slot?.dataset.slot === EXTRA_SLOT) this.openFlyout(EXTRA_SLOT, slot);
      else if (slot) e.setTool(slot.dataset.tool!);
    });
    el.addEventListener('contextmenu', (ev) => {
      const slot = (ev.target as HTMLElement).closest<HTMLElement>('[data-slot]');
      if (!slot) {
        if (!(ev.target as HTMLElement).closest('button')) {
          ev.preventDefault();
          showContextMenu(e, ev.clientX, ev.clientY, ['edit.toolbar']);
        }
        return;
      }
      ev.preventDefault();
      this.openFlyout(slot.dataset.slot!, slot);
    });
    // Hovering a tool starts loading its implementation.
    el.addEventListener('pointerover', (ev) => {
      const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-tool],[data-flyout-tool]');
      if (id) tools.get(id.dataset.tool ?? id.dataset.flyoutTool ?? '')?.prefetch?.();
    });
    // A long press opens the group's flyout on touch and pen input.
    let timer = 0;
    el.addEventListener('pointerdown', (ev) => {
      const slot = (ev.target as HTMLElement).closest<HTMLElement>('[data-slot]');
      if (!slot || ev.button !== 0) return;
      timer = window.setTimeout(() => this.openFlyout(slot.dataset.slot!, slot), 450);
    });
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('keydown', (ev) => {
      const slot = (ev.target as HTMLElement).closest<HTMLElement>('[data-slot]');
      if (slot && (ev.key === 'ArrowRight' || (ev.key === 'Enter' && ev.altKey))) {
        ev.preventDefault();
        this.openFlyout(slot.dataset.slot!, slot);
      } else if (slot && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
        ev.preventDefault();
        const slots = [...el.querySelectorAll<HTMLElement>('[data-slot]')];
        const at = slots.indexOf(slot);
        slots[(at + (ev.key === 'ArrowDown' ? 1 : -1) + slots.length) % slots.length].focus();
      }
    });
    document.addEventListener('pointerdown', (ev) => {
      if (!(ev.target as HTMLElement).closest('.tool-flyout')) this.closeFlyout();
    });
  }
  private toolFor(group: string) {
    const list = groupTools(group);
    const id = this.current.get(group);
    return list.find((t) => t.id === id) ?? list[0];
  }
  select(id: string) {
    const t = tools.get(id);
    if (t) this.current.set(toolSlot(t, toolbarLayout()), id);
  }
  render() {
    const active = this.e.tool;
    let html = '';
    for (const group of slotOrder(toolGroups, toolbarLayout())) {
      const t = this.toolFor(group);
      if (!t) continue;
      if (separatorsBefore.has(group) && html) html += '<div class="tool-separator" role="separator"></div>';
      const many = groupTools(group).length > 1;
      const more = many ? `\n${t.key ? `Shift+${t.key.toUpperCase()} or right-click` : 'Right-click'} for the other tools in this slot` : '';
      html += `<button class="tool-slot ${many ? 'has-flyout' : ''}" data-slot="${group}" data-tool="${t.id}" aria-label="${escapeXML(t.label)}" title="${escapeXML(toolTitle(t) + more)}" aria-pressed="${groupTools(group).some((g) => g.id === active) && t.id === active}">${svg(t.icon)}</button>`;
    }
    // Tools moved out of the toolbar stay one click away in the Extra Tools slot.
    const extra = groupTools(EXTRA_SLOT);
    if (extra.length) {
      const current = extra.find((t) => t.id === active);
      html += `<div class="tool-separator" role="separator"></div><button class="tool-slot extra-tools-slot has-flyout" data-slot="${EXTRA_SLOT}" data-tool="${current?.id ?? ''}" aria-haspopup="menu" aria-label="Extra tools${current ? `: ${escapeXML(current.label)}` : ''}" title="Extra tools${current ? ` — ${escapeXML(current.label)}` : ''}" aria-pressed="${!!current}">${svg(current?.icon ?? 'ellipsis')}</button>`;
    }
    const slots = this.el.querySelector<HTMLElement>('.tool-slots')!;
    // The toolbar redraws after every edit: keep unchanged markup, and the
    // keyboard focus on the slot that had it.
    if (this.markup === html) return;
    this.markup = html;
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-slot]');
    const slot = focused && slots.contains(focused) ? focused.dataset.slot : undefined;
    slots.innerHTML = html;
    if (slot) slots.querySelector<HTMLElement>(`[data-slot="${CSS.escape(slot)}"]`)?.focus({ preventScroll: true });
  }
  private markup = '';
  private openFlyout(group: string, anchor: HTMLElement) {
    this.closeFlyout();
    const list = groupTools(group);
    const extra = group === EXTRA_SLOT;
    if (list.length < (extra ? 1 : 2)) return;
    const pop = document.createElement('div');
    pop.className = 'tool-flyout';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = list
      .map((t) => `<button role="menuitemradio" aria-checked="${t.id === this.e.tool}" data-flyout-tool="${t.id}" title="${escapeXML(toolTitle(t))}">${svg(t.icon)}<span>${escapeXML(t.label)}</span><kbd>${t.key ?? ''}</kbd></button>`)
      .join('') + (extra ? `<div class="tool-flyout-separator" role="separator"></div><button role="menuitem" data-flyout-command="edit.toolbar">${svg('settings', 16)}<span>Edit Toolbar…</span></button>` : '');
    // Fixed to the page: inside the scrollable toolbar it would scroll it sideways.
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${Math.min(r.top, innerHeight - pop.offsetHeight - 4)}px`;
    pop.style.left = `${r.right + 4}px`;
    pop.addEventListener('click', (ev) => {
      const command = (ev.target as HTMLElement).closest<HTMLElement>('[data-flyout-command]');
      if (command) {
        this.closeFlyout();
        void this.e.runCommand(command.dataset.flyoutCommand!);
        return;
      }
      const item = (ev.target as HTMLElement).closest<HTMLElement>('[data-flyout-tool]');
      if (!item) return;
      this.closeFlyout();
      this.e.setTool(item.dataset.flyoutTool!);
      // Chosen from the keyboard (a click without a pointer): the focus goes
      // back to the slot, which the redraw may have replaced.
      if (ev.detail === 0) this.el.querySelector<HTMLElement>(`[data-slot="${CSS.escape(group)}"]`)?.focus();
    });
    pop.addEventListener('keydown', (ev) => {
      const items = [...pop.querySelectorAll<HTMLElement>('button')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (ev.key === 'ArrowDown') items[(at + 1) % items.length].focus();
      else if (ev.key === 'ArrowUp') items[(at - 1 + items.length) % items.length].focus();
      else if (ev.key === 'Home') items[0].focus();
      else if (ev.key === 'End') items[items.length - 1].focus();
      else if (ev.key === 'Escape' || ev.key === 'Tab') {
        // Tab closes it too, so the flyout never stays open behind the focus.
        this.closeFlyout();
        anchor.focus();
      } else return;
      ev.preventDefault();
    });
    pop.querySelector<HTMLElement>('[aria-checked="true"]')?.focus() ?? pop.querySelector<HTMLElement>('button')?.focus();
  }
  closeFlyout() {
    document.querySelector('.tool-flyout')?.remove();
  }
  /** Shortcut handling: a key selects its group's current tool; Shift+key cycles. */
  shortcut(key: string, shift: boolean) {
    const matching = [...tools.values()].filter((t) => t.key?.toUpperCase() === key.toUpperCase());
    if (!matching.length) return false;
    const group = toolSlot(matching[0], toolbarLayout());
    const list = groupTools(group).filter((t) => t.key?.toUpperCase() === key.toUpperCase());
    const currentId = this.toolFor(group)?.id;
    let next = list.find((t) => t.id === currentId) ?? list[0];
    // With Tools → Use Shift key for tool switch off, the plain key cycles too.
    const cycle = shift || !this.e.preferences.shiftToolSwitch;
    if (cycle && this.e.tool && list.some((t) => t.id === this.e.tool)) next = list[(list.findIndex((t) => t.id === this.e.tool) + 1) % list.length];
    this.e.setTool(next.id);
    return true;
  }
}
