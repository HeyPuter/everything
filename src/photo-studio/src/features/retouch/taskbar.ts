// Quick Actions Bar: a small floating bar under the selection (or near the
// bottom of the canvas) offering the likely next steps for what is selected:
// a selection, a layer mask, a type, shape, pixel, embedded, adjustment, fill
// or group layer, several layers, or nothing. Hidden while a tool is dragging,
// during transforms, crops, text editing and modal work. It can be dragged by
// its grip (or moved with the arrow keys on the grip) and then stays where it
// was put until its position is reset; hiding it is remembered.
import type { Editor } from '../../editor';
import { commands, registerCommand, tools } from '../../app/registry';
import { onActivity } from '../../app/activity';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { selectedRoots } from '../../model/layers';
import { placeBar, pinnedAt, quickExtras, quickItems, quickState, validPinned, type PinnedPlace, type QuickItem, type QuickState } from './taskbar-actions';

const KEY = 'photo-studio-taskbar';
const PLACE_KEY = 'photo-studio-taskbar-place';
let visible = true;
let pinned: PinnedPlace | undefined;
try {
  visible = localStorage.getItem(KEY) !== 'off';
  pinned = validPinned(JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null'));
} catch {
  /* Preferences are optional. */
}
function save() {
  try {
    localStorage.setItem(KEY, visible ? 'on' : 'off');
    if (pinned) localStorage.setItem(PLACE_KEY, JSON.stringify(pinned));
    else localStorage.removeItem(PLACE_KEY);
  } catch {
    /* Optional. */
  }
}
let rerender = () => {};
/** Whether the bar is turned on (it still hides when there is nothing to offer). */
export const taskbarVisible = () => visible;
/** Turn the bar on or off (Assisted mode), remembered like the menu toggle. */
export function setTaskbarVisible(on: boolean) {
  if (visible === on) return;
  visible = on;
  save();
  rerender();
}

/** The bar's state for the editor as it is now. */
export function taskbarState(e: Editor): QuickState {
  if (!e.hasDocument) return 'none';
  const doc = e.doc;
  const roots = selectedRoots(doc.layers, e.selectedIds);
  return quickState({
    hasDocument: true,
    selection: !!(doc.selection || doc.selectionMask),
    quickMask: !!doc.quickMask,
    editingMask: e.editingMask,
    layers: roots.map((l) => ({ kind: l.kind, embedded: !!l.embed, hasMask: !!(l.maskGrid || l.pixelMask || l.mask || l.maskAsset || l.maskStrokes) })),
  });
}

// Tools whose own on-canvas controls take the place of the bar.
const OWN_CONTROLS = new Set(['crop', 'perspective-crop', 'transform-session', 'pin-warp', 'perspective-warp', 'context-scale']);

type MenuEntry = '-' | { label: string; run: () => void; enabled?: boolean; checked?: boolean; shortcut?: string };
function commandEntry(e: Editor, id: string): MenuEntry | undefined {
  const c = commands.get(id);
  if (!c) return undefined;
  const safe = <T,>(f: () => T, fallback: T) => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  return { label: c.label, run: () => void e.runCommand(id), enabled: c.enabled ? safe(() => c.enabled!(e), false) : true, checked: c.checked ? safe(() => c.checked!(e), false) : undefined };
}

/** A small menu under a bar button; arrows move, Enter runs, Escape closes. */
function openMenu(anchor: HTMLElement, entries: MenuEntry[], label: string) {
  document.querySelector('.taskbar-menu')?.remove();
  const list = entries.filter((x, i, all) => x !== '-' || (i > 0 && all[i - 1] !== '-' && i < all.length - 1));
  const pop = document.createElement('div');
  pop.className = 'menu-pop context-menu taskbar-menu';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', label);
  pop.innerHTML = list
    .map((x, i) =>
      x === '-'
        ? '<div class="menu-separator" role="separator"></div>'
        : `<div class="menu-item" role="${x.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}" ${x.checked !== undefined ? `aria-checked="${x.checked}"` : ''} data-entry="${i}" tabindex="-1" ${x.enabled === false ? 'aria-disabled="true"' : ''}><span class="menu-check">${x.checked ? '✓' : ''}</span><span class="menu-label">${escapeXML(x.label)}</span><kbd></kbd></div>`,
    )
    .join('');
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(),
    pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pr.width - 4))}px`;
  // Below the button, or above it near the bottom of the window.
  pop.style.top = `${r.bottom + pr.height + 4 > innerHeight ? Math.max(4, r.top - pr.height - 4) : r.bottom + 4}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const close = (focus = true) => {
    pop.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const outside = (ev: Event) => {
    if (!pop.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close(false);
  };
  document.addEventListener('pointerdown', outside, true);
  const activate = (item: HTMLElement) => {
    const entry = list[Number(item.dataset.entry)];
    if (entry === '-' || entry.enabled === false) return;
    close();
    entry.run();
  };
  pop.addEventListener('click', (ev) => {
    const item = (ev.target as HTMLElement).closest<HTMLElement>('.menu-item');
    if (item) activate(item);
  });
  pop.addEventListener('pointerover', (ev) => (ev.target as HTMLElement).closest<HTMLElement>('.menu-item')?.focus({ preventScroll: true }));
  pop.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    const items = [...pop.querySelectorAll<HTMLElement>('.menu-item')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (ev.key === 'Escape' || ev.key === 'Tab') close();
    else if (ev.key === 'ArrowDown') items[(at + 1) % items.length].focus();
    else if (ev.key === 'ArrowUp') items[(at - 1 + items.length) % items.length].focus();
    else if (ev.key === 'Home') items[0].focus();
    else if (ev.key === 'End') items[items.length - 1].focus();
    else if ((ev.key === 'Enter' || ev.key === ' ') && at >= 0) activate(items[at]);
    else return;
    ev.preventDefault();
  });
  pop.querySelector<HTMLElement>('.menu-item:not([aria-disabled])')?.focus({ preventScroll: true });
}

export function installTaskbar(e: Editor) {
  const bar = document.createElement('div');
  bar.className = 'contextual-taskbar canvas-ui';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Quick actions bar');
  bar.hidden = true;
  let signature = '';
  let placed = false;
  let items: QuickItem[] = [];
  let state: QuickState = 'none';
  const viewport = () => e.el('#viewport');
  const place = () => {
    if (bar.hidden) return;
    const vr = viewport().getBoundingClientRect();
    const s = e.doc.selection;
    let sel;
    if (s && !pinned) {
      const [x0, y1] = e.clientPoint(s.x, s.y + s.height);
      const [x1, y0] = e.clientPoint(s.x + s.width, s.y);
      sel = { left: Math.min(x0, x1) - vr.left, right: Math.max(x0, x1) - vr.left, top: Math.min(y0, y1) - vr.top, bottom: Math.max(y0, y1) - vr.top };
    }
    const at = placeBar({ width: vr.width, height: vr.height }, { width: bar.offsetWidth, height: bar.offsetHeight }, sel, pinned);
    bar.style.left = `${at.left}px`;
    bar.style.top = `${at.top}px`;
    bar.classList.toggle('pinned', !!pinned);
    placed = true;
  };
  const enabled = (id: string) => {
    const c = commands.get(id);
    try {
      return !!c && c.enabled?.(e) !== false;
    } catch {
      return false;
    }
  };
  const checked = (id: string) => {
    try {
      return !!commands.get(id)?.checked?.(e);
    } catch {
      return false;
    }
  };
  const label = (i: QuickItem) => (i.kind === 'command' && i.checkedLabel && checked(i.id) ? i.checkedLabel : i.label);
  const button = (i: QuickItem, n: number) => {
    const text = escapeXML(label(i));
    if (i.kind === 'menu') {
      const on = i.items.some((id) => id !== '-' && enabled(id));
      return `<button type="button" data-taskbar-menu="${n}" aria-haspopup="menu" aria-expanded="false" ${on ? '' : 'disabled'} title="${text}">${svg(i.icon, 15)}<span>${text}</span>${svg('chevron-down', 12)}</button>`;
    }
    if (i.kind === 'tool') {
      const t = tools.get(i.tool);
      return `<button type="button" data-taskbar-tool="${i.tool}" title="${escapeXML(t ? `${i.label} (${t.label})` : i.label)}">${svg(i.icon, 15)}<span>${text}</span></button>`;
    }
    const c = commands.get(i.id)!;
    return `<button type="button" data-taskbar="${i.id}" ${enabled(i.id) ? '' : 'disabled'} title="${escapeXML(c.description ?? label(i))}">${svg(i.icon, 15)}<span>${text}</span></button>`;
  };
  let recheck = 0;
  const render = () => {
    // Commands update the document while the editor is busy; look again once they finish.
    clearTimeout(recheck);
    if (e.busy || e.toolBusy) recheck = window.setTimeout(render, 120);
    const blocked = !visible || e.toolBusy || e.busy || e.transform.active || OWN_CONTROLS.has(e.tool) || !!e.settings.typeSession || !!document.querySelector('dialog[open]');
    state = blocked ? 'none' : taskbarState(e);
    items = quickItems(state).filter((i) => i.kind !== 'command' || commands.has(i.id));
    const sig = `${state}:${items.map((i) => (i.kind === 'command' ? `${i.id}:${enabled(i.id)}:${label(i)}` : i.kind === 'menu' ? `${i.label}:${i.items.some((id) => id !== '-' && enabled(id))}` : i.tool)).join('|')}`;
    bar.hidden = !items.length;
    bar.dataset.state = state;
    if (sig !== signature) {
      signature = sig;
      // Keep the keyboard focus on the same button when the bar is redrawn.
      const focused = bar.contains(document.activeElement) ? [...bar.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement) : -1;
      bar.innerHTML =
        `<button type="button" class="taskbar-grip" data-taskbar-grip aria-label="Move the quick actions bar" title="Drag to move (arrow keys move it too)">${svg('grip-vertical', 14)}</button>` +
        items.map(button).join('') +
        `<button type="button" class="taskbar-more" data-taskbar-more aria-haspopup="menu" aria-expanded="false" aria-label="More quick actions and bar options" title="More">${svg('ellipsis', 15)}</button>`;
      // One tab stop: arrow keys move between the buttons.
      const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
      const keep = focused >= 0 ? Math.min(focused, buttons.length - 1) : buttons.findIndex((b, i) => i > 0 && !b.disabled);
      buttons.forEach((b, i) => (b.tabIndex = i === Math.max(0, keep) ? 0 : -1));
      if (focused >= 0) buttons[Math.min(focused, buttons.length - 1)]?.focus({ preventScroll: true });
      placed = false;
    }
    if (!bar.hidden) place();
    else placed = false;
  };
  const moreMenu = (anchor: HTMLElement) => {
    const extras = quickExtras(state)
      .map((id) => (id === '-' ? '-' : commandEntry(e, id)))
      .filter((x): x is MenuEntry => !!x);
    openMenu(
      anchor,
      [
        ...extras,
        '-',
        {
          label: 'Pin Bar Position',
          checked: !!pinned,
          run: () => {
            const vr = viewport().getBoundingClientRect();
            pinned = pinned ? undefined : pinnedAt({ width: vr.width, height: vr.height }, { width: bar.offsetWidth, height: bar.offsetHeight }, bar.offsetLeft, bar.offsetTop);
            save();
            place();
          },
        },
        {
          label: 'Reset Bar Position',
          enabled: !!pinned,
          run: () => {
            pinned = undefined;
            save();
            place();
          },
        },
        { label: 'Hide Bar', run: () => hide() },
      ],
      'More quick actions',
    );
  };
  const hide = () => {
    visible = false;
    save();
    render();
    e.message('Quick actions bar hidden. Show it again from Window › Quick Actions Bar.');
    viewport().focus({ preventScroll: true });
  };
  const moveTo = (left: number, top: number) => {
    const vr = viewport().getBoundingClientRect();
    pinned = pinnedAt({ width: vr.width, height: vr.height }, { width: bar.offsetWidth, height: bar.offsetHeight }, left, top);
    place();
  };
  // Dragging the grip moves the bar and pins it where it is dropped.
  let drag: { id: number; dx: number; dy: number } | undefined;
  bar.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    const grip = (ev.target as HTMLElement).closest('[data-taskbar-grip]');
    if (!grip || ev.button !== 0) return;
    ev.preventDefault();
    drag = { id: ev.pointerId, dx: ev.clientX - bar.offsetLeft, dy: ev.clientY - bar.offsetTop };
    bar.setPointerCapture(ev.pointerId);
    bar.classList.add('dragging');
  });
  bar.addEventListener('pointermove', (ev) => {
    if (drag?.id === ev.pointerId) moveTo(ev.clientX - drag.dx, ev.clientY - drag.dy);
  });
  const endDrag = (ev: PointerEvent) => {
    if (drag?.id !== ev.pointerId) return;
    drag = undefined;
    bar.classList.remove('dragging');
    save();
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  bar.addEventListener('lostpointercapture', endDrag);
  bar.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    // Keys stay in the bar: arrows would otherwise nudge layers.
    ev.stopPropagation();
    if (target.closest('[data-taskbar-grip]') && ev.key.startsWith('Arrow')) {
      const step = ev.shiftKey ? 40 : 10;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0,
        dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      moveTo(bar.offsetLeft + dx, bar.offsetTop + dy);
      save();
      ev.preventDefault();
      return;
    }
    let next = -1;
    if (ev.key === 'ArrowRight') next = (at + 1) % buttons.length;
    else if (ev.key === 'ArrowLeft') next = (at - 1 + buttons.length) % buttons.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = buttons.length - 1;
    else if (ev.key === 'Escape') {
      viewport().focus({ preventScroll: true });
      ev.preventDefault();
      return;
    } else return;
    ev.preventDefault();
    buttons.forEach((b, i) => (b.tabIndex = i === next ? 0 : -1));
    buttons[next].focus({ preventScroll: true });
  });
  bar.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const more = t.closest<HTMLElement>('[data-taskbar-more]');
    if (more) return moreMenu(more);
    const menuButton = t.closest<HTMLButtonElement>('[data-taskbar-menu]');
    const menuItem = menuButton && items[Number(menuButton.dataset.taskbarMenu)];
    if (menuButton && menuItem?.kind === 'menu') {
      const entries = menuItem.items.map((id) => (id === '-' ? '-' : commandEntry(e, id))).filter((x): x is MenuEntry => !!x);
      return openMenu(menuButton, entries, menuItem.label);
    }
    const toolButton = t.closest<HTMLElement>('[data-taskbar-tool]');
    if (toolButton) {
      e.setTool(toolButton.dataset.taskbarTool!);
      return;
    }
    const b = t.closest<HTMLButtonElement>('[data-taskbar]');
    if (b && !b.disabled) void e.runCommand(b.dataset.taskbar!).then(render);
  });
  viewport().append(bar);
  e.onUpdate(render);
  rerender = render;
  // Choosing a tool does not update the document; tools with their own controls hide the bar.
  onActivity((a) => a.kind === 'tool' && render());
  // Pan and zoom move the stage; follow it.
  new MutationObserver(() => placed && place()).observe(e.el('#stage'), { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('resize', () => placed && place());
  // Dialogs open and close without an update; re-check cheaply.
  let lastBlocked = false;
  window.setInterval(() => {
    const blocked = !!document.querySelector('dialog[open]');
    if (blocked !== lastBlocked) {
      lastBlocked = blocked;
      render();
    }
  }, 250);
  registerCommand({
    id: 'window.contextual-taskbar',
    label: 'Quick Actions Bar',
    checked: () => visible,
    recordable: false,
    run: () => {
      visible = !visible;
      save();
      render();
    },
  });
}
