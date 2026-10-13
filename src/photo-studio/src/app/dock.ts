import type { Editor } from '../editor';
import { escapeXML } from '../model/assets';
import { svg } from './icons';
import { showContextMenu } from './menubar';
import { commands, panels, registerCommand, type MenuItem, type Panel, type PanelLocation } from './registry';
import { BottomDock } from './bottom-dock';

const groupLocations: PanelLocation[] = ['dock-top', 'dock-middle', 'dock-bottom'];
const allLocations: PanelLocation[] = [...groupLocations, 'strip'];
/** Arrangement of the dock. Panels keep their registered location unless a
 * workspace or a dragged tab places them elsewhere. */
export type DockLayout = {
  active: Record<string, string>;
  collapsed: string[];
  sizes: Record<string, number>;
  // Panel ID → location overrides.
  placement?: Record<string, PanelLocation>;
  // Panel order within groups and the strip; unlisted panels follow in registration order.
  order?: string[];
  // Panels removed from the dock; Window → Panels brings them back.
  closed?: string[];
};
const storageKey = 'photo-studio-dock';
// Icon strip sections, in order: panels of one kind sit together (until the
// user drags them elsewhere) and each section is a labelled group.
const stripSections: [string, string[]][] = [
  ['Assist', ['assistant', 'generations']],
  ['History', ['history', 'actions', 'versions']],
  ['Inspect', ['navigator', 'info', 'histogram', 'measurement-log', 'notes', 'comments']],
  ['Painting', ['brushes', 'brush-settings', 'tool-presets', 'clone-source']],
  ['Type', ['character', 'paragraph', 'glyphs', 'character-styles', 'paragraph-styles']],
  ['Layers', ['styles', 'shapes', 'layer-comps']],
];
const stripSection = (id: string) => {
  const i = stripSections.findIndex(([, ids]) => ids.includes(id));
  return i < 0 ? stripSections.length : i;
};

export function emptyDockLayout(): DockLayout {
  return { active: {}, collapsed: [], sizes: {} };
}
/** Accept a stored or imported layout, dropping malformed parts. */
export function sanitizeDockLayout(v: unknown): DockLayout {
  const out = emptyDockLayout();
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  const record = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
  for (const [k, id] of Object.entries(record(o.active))) if (typeof id === 'string') out.active[k] = id;
  out.collapsed = strings(o.collapsed).filter((l) => (groupLocations as string[]).includes(l));
  for (const [k, n] of Object.entries(record(o.sizes))) if (typeof n === 'number' && Number.isFinite(n) && n > 0) out.sizes[k] = n;
  const placement = Object.entries(record(o.placement)).filter(([, l]) => (allLocations as unknown[]).includes(l));
  if (placement.length) out.placement = Object.fromEntries(placement) as Record<string, PanelLocation>;
  if (Array.isArray(o.order)) out.order = strings(o.order);
  if (Array.isArray(o.closed)) out.closed = strings(o.closed);
  return out;
}
function loadLayout(): DockLayout {
  try {
    return sanitizeDockLayout(JSON.parse(localStorage.getItem(storageKey) ?? ''));
  } catch {
    /* Layout persistence is optional. */
  }
  return emptyDockLayout();
}

/** Right-hand panel dock: three tabbed groups plus an icon strip whose
 * panels open as drawers, so many panels fit beside the canvas. Tabs and strip
 * icons can be dragged between groups unless the workspace is locked. */
export class Dock {
  private layout = loadLayout();
  private mounted = new Map<string, HTMLElement>();
  private drawer?: string;
  // Panels docked under the canvas.
  readonly bottom: BottomDock;
  private dragging?: string;
  // The panel whose menu is open; the standard panel menu commands act on it.
  private menuTarget?: string;
  // A locked workspace keeps its arrangement: no dragging, resizing or collapsing.
  locked = false;
  // Called after the arrangement changes (not after tab switches alone).
  onChange?: () => void;
  constructor(
    private e: Editor,
    private el: HTMLElement,
  ) {
    this.bottom = new BottomDock(e, e.el('.bottom-dock'));
    // Workspace → Auto-collapse icon panels: a press outside the open drawer
    // (and outside menus and dialogs it may have opened) closes it.
    document.addEventListener(
      'pointerdown',
      (ev) => {
        if (!this.drawer || !e.preferences.autoCollapsePanels) return;
        const t = ev.target as HTMLElement;
        if (!t.isConnected || t.closest('.dock, dialog, .menu-pop, .context-menu, .popover, .tool-flyout')) return;
        this.toggleDrawer(undefined);
      },
      true,
    );
    el.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      const tab = target.closest<HTMLElement>('[data-panel-tab]');
      if (tab) {
        this.activate(tab.dataset.panelTab!);
        return;
      }
      const stripButton = target.closest<HTMLElement>('[data-strip-panel]');
      if (stripButton) {
        const id = stripButton.dataset.stripPanel!;
        this.toggleDrawer(this.drawer === id ? undefined : id);
        return;
      }
      const menu = target.closest<HTMLElement>('[data-panel-menu]');
      if (menu) {
        this.openMenu(menu.dataset.panelMenu!, menu);
        return;
      }
      const close = target.closest<HTMLElement>('[data-drawer-close]');
      if (close) this.toggleDrawer(undefined);
    });
    el.addEventListener('dblclick', (ev) => {
      const bar = (ev.target as HTMLElement).closest<HTMLElement>('.panel-tabs');
      if (!bar || this.locked || (ev.target as HTMLElement).closest('button:not([data-panel-tab])')) return;
      const loc = bar.parentElement!.dataset.location!;
      const i = this.layout.collapsed.indexOf(loc);
      if (i >= 0) this.layout.collapsed.splice(i, 1);
      else this.layout.collapsed.push(loc);
      this.changed();
    });
    el.addEventListener('keydown', (ev) => {
      const icon = (ev.target as HTMLElement).closest<HTMLElement>('[data-strip-panel]');
      if (icon && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) {
        const icons = [...this.el.querySelectorAll<HTMLElement>('[data-strip-panel]')];
        const at = icons.indexOf(icon);
        const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? icons.length - 1 : (at + (ev.key === 'ArrowDown' ? 1 : -1) + icons.length) % icons.length;
        icons[next]?.focus();
        ev.preventDefault();
        return;
      }
      const tab = (ev.target as HTMLElement).closest<HTMLElement>('[data-panel-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
      const tabs = [...tab.parentElement!.querySelectorAll<HTMLElement>('[data-panel-tab]')];
      const next = tabs[(tabs.indexOf(tab) + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      this.activate(next.dataset.panelTab!);
      this.el.querySelector<HTMLElement>(`[data-panel-tab="${next.dataset.panelTab}"]`)?.focus();
      ev.preventDefault();
    });
    this.bindResize();
    this.bindDrag();
  }
  private save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.layout));
    } catch {
      /* Optional. */
    }
  }
  private changed() {
    this.save();
    this.render();
    this.onChange?.();
  }
  /** Current arrangement (a copy). */
  getLayout(): DockLayout {
    return structuredClone(this.layout);
  }
  /** Replace the arrangement (workspace switch or reset). */
  setLayout(layout: DockLayout) {
    this.layout = sanitizeDockLayout(structuredClone(layout));
    if (this.drawer && !this.inDock(this.drawer)) this.drawer = undefined;
    this.save();
    this.render();
  }
  locationOf(p: Panel): PanelLocation {
    return this.layout.placement?.[p.id] ?? p.location;
  }
  private inDock(id: string) {
    const p = panels.get(id);
    return !!p && !p.hidden && !this.layout.closed?.includes(id);
  }
  private group(loc: PanelLocation) {
    const order = this.layout.order ?? [];
    const rank = (id: string) => {
      const i = order.indexOf(id);
      return i < 0 ? order.length : i;
    };
    return [...panels.values()]
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => this.locationOf(p) === loc && this.inDock(p.id))
      .sort((a, b) => rank(a.p.id) - rank(b.p.id) || (loc === 'strip' ? stripSection(a.p.id) - stripSection(b.p.id) : 0) || a.i - b.i)
      .map(({ p }) => p);
  }
  private activeIn(loc: PanelLocation) {
    const list = this.group(loc);
    return list.find((p) => p.id === this.layout.active[loc]) ?? list[0];
  }
  /** Register Window → Panels commands for every panel. */
  registerCommands() {
    for (const p of panels.values())
      // A feature may register the command itself (listed directly in the
      // Window menu instead of Window → Panels); it is kept.
      if (!commands.has(`window.panel.${p.id}`))
        registerCommand({
          id: `window.panel.${p.id}`,
          label: p.title,
          shortcut: p.shortcut,
          menu: 'window.panels',
          checked: () => this.isVisible(p.id),
          run: () => this.show(p.id, true),
          recordable: false,
        });
    // Standard items closing every panel menu. IDs share the `window.panel.`
    // prefix so command search leaves them out; they act on `menuTarget`.
    const target = () => (this.menuTarget ? panels.get(this.menuTarget) : undefined);
    const where = () => {
      const p = target();
      return p ? (p.location === 'bottom' ? 'bottom' : this.locationOf(p)) : undefined;
    };
    registerCommand(
      {
        id: 'window.panel.menu-close',
        label: 'Close',
        recordable: false,
        enabled: () => !!target() && !this.locked,
        run: () => {
          const p = target();
          if (p?.location === 'bottom') this.bottom.close();
          else if (p) this.close(p.id);
        },
      },
      {
        id: 'window.panel.menu-close-group',
        label: 'Close Tab Group',
        recordable: false,
        enabled: () => !this.locked && !!where()?.startsWith('dock-'),
        run: () => {
          const loc = where();
          if (!loc?.startsWith('dock-')) return;
          this.layout.closed = [...new Set([...(this.layout.closed ?? []), ...this.group(loc).map((p) => p.id)])];
          this.changed();
        },
      },
      {
        id: 'window.panel.menu-minimize',
        label: 'Minimize Tab Group',
        recordable: false,
        checked: () => this.layout.collapsed.includes(where() ?? ''),
        enabled: () => !this.locked && !!where()?.startsWith('dock-'),
        run: () => {
          const loc = where();
          if (!loc?.startsWith('dock-')) return;
          const i = this.layout.collapsed.indexOf(loc);
          if (i >= 0) this.layout.collapsed.splice(i, 1);
          else this.layout.collapsed.push(loc);
          this.changed();
        },
      },
      {
        id: 'window.panel.menu-to-strip',
        label: 'Collapse to Icon',
        recordable: false,
        enabled: () => !this.locked && !!where()?.startsWith('dock-'),
        run: () => {
          const p = target();
          if (p) this.move(p.id, 'strip');
        },
      },
      {
        id: 'window.panel.menu-to-group',
        label: 'Dock as Tab',
        recordable: false,
        enabled: () => !this.locked && where() === 'strip',
        run: () => {
          const p = target();
          if (!p) return;
          this.move(p.id, p.location === 'strip' ? 'dock-middle' : p.location);
          this.show(p.id);
        },
      },
    );
  }
  /** Items of a panel's menu: its own commands, then the standard ones. */
  panelMenu(id: string): MenuItem[] {
    const p = panels.get(id);
    if (!p) return [];
    const own = p.menu?.(this.e) ?? [];
    const loc = p.location === 'bottom' ? 'bottom' : this.locationOf(p);
    const standard: MenuItem[] =
      loc === 'bottom' ? ['window.panel.menu-close'] : loc === 'strip' ? ['window.panel.menu-to-group', 'window.panel.menu-close'] : ['window.panel.menu-minimize', 'window.panel.menu-to-strip', '-', 'window.panel.menu-close', 'window.panel.menu-close-group'];
    return [...own, ...(own.length ? ['-' as const] : []), ...standard];
  }
  /** Open a panel's menu under its menu button. */
  openMenu(id: string, anchor: HTMLElement) {
    this.menuTarget = id;
    const r = anchor.getBoundingClientRect();
    anchor.setAttribute('aria-expanded', 'true');
    showContextMenu(this.e, r.right, r.bottom + 2, this.panelMenu(id), true);
    // The menu closes on the next pointer press or command; the button follows.
    const pop = document.querySelector('.context-menu');
    if (!pop) return anchor.setAttribute('aria-expanded', 'false');
    new MutationObserver((_, obs) => {
      if (pop.isConnected) return;
      anchor.setAttribute('aria-expanded', 'false');
      obs.disconnect();
    }).observe(document.body, { childList: true });
  }
  isVisible(id: string) {
    const p = panels.get(id);
    if (!p) return false;
    if (p.location === 'bottom') return !p.hidden && this.bottom.isVisible(id);
    if (!this.inDock(id)) return false;
    const loc = this.locationOf(p);
    if (loc === 'strip') return this.drawer === id;
    return this.activeIn(loc)?.id === id && !this.layout.collapsed.includes(loc);
  }
  /** Bring a panel forward (toggle when invoked from the Window menu). */
  show(id: string, toggle = false) {
    const p = panels.get(id);
    if (!p) return;
    if (p.location === 'bottom') return this.bottom.show(id, toggle);
    const loc = this.locationOf(p);
    if (toggle && this.isVisible(id)) {
      if (loc === 'strip') this.toggleDrawer(undefined);
      else {
        this.layout.collapsed.push(loc);
        this.save();
        this.render();
      }
      return;
    }
    p.hidden = false;
    if (this.layout.closed?.includes(id)) {
      this.layout.closed = this.layout.closed.filter((c) => c !== id);
      this.onChange?.();
    }
    if (loc === 'strip') this.toggleDrawer(id);
    else {
      this.layout.collapsed = this.layout.collapsed.filter((l) => l !== loc);
      this.activate(id);
    }
  }
  /** Remove a panel from the dock until it is shown again. */
  close(id: string) {
    if (this.locked) return;
    this.layout.closed = [...new Set([...(this.layout.closed ?? []), id])];
    if (this.drawer === id) this.drawer = undefined;
    this.changed();
  }
  /** Place a panel in a group or the strip, before another panel when given. */
  move(id: string, loc: PanelLocation, before?: string) {
    const p = panels.get(id);
    if (!p || this.locked || before === id) return;
    const placement = { ...(this.layout.placement ?? {}) };
    if (loc === p.location) delete placement[id];
    else placement[id] = loc;
    this.layout.placement = Object.keys(placement).length ? placement : undefined;
    // Rebuild the full order so the drop position is exact.
    const ids = [...panels.keys()];
    const order = (this.layout.order ?? []).filter((x) => x !== id && panels.has(x));
    for (const x of ids) if (x !== id && !order.includes(x)) order.push(x);
    const at = before ? order.indexOf(before) : -1;
    if (at >= 0) order.splice(at, 0, id);
    else order.push(id);
    this.layout.order = order;
    this.layout.closed = this.layout.closed?.filter((c) => c !== id);
    if (loc === 'strip') {
      if (this.drawer === id) this.drawer = undefined;
    } else {
      this.layout.active[loc] = id;
      this.layout.collapsed = this.layout.collapsed.filter((l) => l !== loc);
    }
    this.changed();
  }
  activate(id: string) {
    const p = panels.get(id);
    if (!p) return;
    this.layout.active[this.locationOf(p)] = id;
    this.save();
    this.render();
  }
  private toggleDrawer(id: string | undefined) {
    this.drawer = id;
    this.render();
  }
  private body(p: Panel) {
    let el = this.mounted.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'panel-body';
      el.dataset.panel = p.id;
      el.id = `panel-${p.id}`;
      el.setAttribute('role', 'tabpanel');
      el.setAttribute('aria-label', p.title);
      p.mount(this.e, el);
      this.mounted.set(p.id, el);
    }
    return el;
  }
  render() {
    this.bottom.render();
    const column = this.el.querySelector<HTMLElement>('.dock-column')!;
    this.el.classList.toggle('dock-locked', this.locked);
    const draggable = this.locked ? 'false' : 'true';
    // Detach mounted bodies before rebuilding the chrome so their state survives.
    for (const body of this.mounted.values()) body.remove();
    // Empty groups stay in the markup as drop zones, shown only while dragging.
    column.innerHTML = groupLocations
      .map((loc) => {
        const list = this.group(loc);
        if (!list.length) return `<section class="panel-group empty" data-location="${loc}"><div class="panel-tabs" data-drop-location="${loc}"><span class="drop-hint">Drop a panel here</span></div></section>`;
        const active = this.activeIn(loc)!;
        const collapsed = this.layout.collapsed.includes(loc);
        const size = this.layout.sizes[loc];
        return `<section class="panel-group ${collapsed ? 'collapsed' : ''}" data-location="${loc}" ${size && !collapsed ? `style="flex:${size} 1 0"` : ''}><div class="panel-tabs" role="tablist" aria-label="Panels" data-drop-location="${loc}">${list
          .map((p) => `<button role="tab" data-panel-tab="${p.id}" draggable="${draggable}" aria-selected="${p.id === active.id}" tabindex="${p.id === active.id ? 0 : -1}" aria-controls="panel-${p.id}">${escapeXML(p.title)}</button>`)
          .join('')}<span class="panel-tabs-spacer"></span>${menuButton(active, 'data-panel-menu')}</div><div class="panel-slot"></div><div class="group-resizer" data-resize="${loc}" aria-hidden="true"></div></section>`;
      })
      .join('');
    for (const loc of groupLocations) {
      const slot = column.querySelector<HTMLElement>(`[data-location="${loc}"] .panel-slot`);
      const active = this.activeIn(loc);
      if (slot && active && !this.layout.collapsed.includes(loc)) {
        slot.append(this.body(active));
        active.update?.(this.e, this.body(active));
      }
    }
    const strip = this.el.querySelector<HTMLElement>('.dock-strip')!;
    const stripPanels = this.group('strip');
    strip.dataset.dropLocation = 'strip';
    strip.innerHTML = stripPanels
      .map((p, i) => {
        const section = stripSection(p.id);
        const start = i === 0 || stripSection(stripPanels[i - 1].id) !== section;
        const end = i === stripPanels.length - 1 || stripSection(stripPanels[i + 1].id) !== section;
        const label = stripSections[section]?.[0] ?? 'More panels';
        return `${start ? `<div class="strip-section" role="group" aria-label="${label}">` : ''}<button data-strip-panel="${p.id}" draggable="${draggable}" aria-label="${escapeXML(p.title)}" title="${escapeXML(p.title)}" aria-pressed="${this.drawer === p.id}" tabindex="${i === 0 ? 0 : -1}">${svg(p.icon)}</button>${end ? '</div>' : ''}`;
      })
      .join('');
    strip.classList.toggle('empty', !stripPanels.length);
    const drawer = this.el.querySelector<HTMLElement>('.dock-drawer')!;
    const open = this.drawer && this.inDock(this.drawer) ? panels.get(this.drawer) : undefined;
    drawer.hidden = !open;
    if (open) {
      drawer.innerHTML = `<div class="panel-tabs"><span class="drawer-title">${svg(open.icon, 14)}${escapeXML(open.title)}</span><span class="panel-tabs-spacer"></span>${menuButton(open, 'data-panel-menu')}<button class="panel-menu-button" data-drawer-close aria-label="Close ${escapeXML(open.title)}" title="Close">${svg('x', 15)}</button></div>`;
      const body = this.body(open);
      drawer.append(body);
      open.update?.(this.e, body);
    }
  }
  /** Refresh visible panels after an edit. */
  update() {
    for (const [id, el] of this.mounted)
      if (el.isConnected) panels.get(id)?.update?.(this.e, el);
    this.bottom.update();
  }
  private bindDrag() {
    const clear = () => this.el.querySelectorAll('.drop-target,.drop-before').forEach((n) => n.classList.remove('drop-target', 'drop-before'));
    // Where a drop at this point lands: the location and the panel it goes before.
    const dropAt = (ev: DragEvent) => {
      const zone = (ev.target as HTMLElement).closest<HTMLElement>('[data-drop-location]');
      if (!zone) return;
      const loc = zone.dataset.dropLocation as PanelLocation;
      const items = [...zone.querySelectorAll<HTMLElement>('[data-panel-tab],[data-strip-panel]')];
      const vertical = loc === 'strip';
      const before = items.find((b) => {
        const r = b.getBoundingClientRect();
        return vertical ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2;
      });
      return { zone, loc, before };
    };
    this.el.addEventListener('dragstart', (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>('[data-panel-tab],[data-strip-panel]');
      if (!item || this.locked) return;
      this.dragging = item.dataset.panelTab ?? item.dataset.stripPanel;
      ev.dataTransfer?.setData('text/x-photo-panel', this.dragging!);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      this.el.classList.add('dock-dragging');
    });
    this.el.addEventListener('dragover', (ev) => {
      if (!this.dragging) return;
      const at = dropAt(ev);
      clear();
      if (!at) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      at.zone.classList.add('drop-target');
      at.before?.classList.add('drop-before');
    });
    this.el.addEventListener('drop', (ev) => {
      const id = this.dragging;
      const at = id ? dropAt(ev) : undefined;
      clear();
      if (!id || !at) return;
      ev.preventDefault();
      this.dragging = undefined;
      this.el.classList.remove('dock-dragging');
      this.move(id, at.loc, at.before ? (at.before.dataset.panelTab ?? at.before.dataset.stripPanel) : undefined);
    });
    this.el.addEventListener('dragend', () => {
      this.dragging = undefined;
      this.el.classList.remove('dock-dragging');
      clear();
    });
  }
  private bindResize() {
    let drag: { loc: string; start: number; a: HTMLElement; b: HTMLElement; ha: number; hb: number } | undefined;
    this.el.addEventListener('pointerdown', (ev) => {
      const handle = (ev.target as HTMLElement).closest<HTMLElement>('[data-resize]');
      if (!handle || this.locked) return;
      const a = handle.parentElement as HTMLElement;
      let b = a.nextElementSibling as HTMLElement | null;
      while (b && b.classList.contains('empty')) b = b.nextElementSibling as HTMLElement | null;
      if (!b) return;
      drag = { loc: handle.dataset.resize!, start: ev.clientY, a, b, ha: a.getBoundingClientRect().height, hb: b.getBoundingClientRect().height };
      handle.setPointerCapture(ev.pointerId);
    });
    this.el.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const d = ev.clientY - drag.start;
      const ha = Math.max(60, drag.ha + d),
        hb = Math.max(60, drag.hb - d);
      drag.a.style.flex = `${ha} 1 0`;
      drag.b.style.flex = `${hb} 1 0`;
      this.layout.sizes[drag.loc] = ha;
      this.layout.sizes[drag.b.dataset.location!] = hb;
    });
    this.el.addEventListener('pointerup', () => {
      if (drag) {
        this.save();
        this.onChange?.();
      }
      drag = undefined;
    });
  }
}

/** The flyout menu button every panel header carries. */
export const menuButton = (p: Panel, attr: string) =>
  `<button class="panel-menu-button" ${attr}="${p.id}" aria-label="${escapeXML(p.title)} panel menu" aria-haspopup="menu" aria-expanded="false" title="Panel menu">${svg('menu', 15)}</button>`;
