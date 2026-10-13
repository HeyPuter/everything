import type { Editor } from '../editor';
import { escapeXML } from '../model/assets';
import { commands, findCommand, menuContributions, type MenuItem } from './registry';
import { menuSkeleton } from './menus';
import { formatShortcut } from './shortcuts';
import { isHiddenInMenus, menuCustomization, menuTag, type MenuCustomization, type MenuTag } from './menu-custom';

export type Resolved =
  | { kind: 'command'; id: string; label: string; shortcut: string; enabled: boolean; checked?: boolean; tag?: MenuTag }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; id?: string; items: Resolved[] };

function dynamicItems(id: string | undefined): MenuItem[] {
  if (!id) return [];
  return [...commands.values()]
    .filter((c) => c.menu === id && !c.hidden)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.order ?? 1e6 + a.i) - (b.c.order ?? 1e6 + b.i))
    .map(({ c }) => c.id);
}
export function withContributions(menu: string, items: MenuItem[]): MenuItem[] {
  const out = [...items];
  for (const c of menuContributions.filter((m) => m.menu === menu)) {
    // The anchor is a command or a submenu ID.
    const at = c.after ? out.findIndex((i) => i === c.after || (typeof i === 'object' && i.id === c.after)) : -1;
    if (at >= 0) out.splice(at + 1, 0, ...c.items);
    else out.push(...c.items);
  }
  return out;
}
/** Resolve menu items against the registry; `custom` applies Edit → Menus
 * customization (menu bar only). */
export function resolveMenu(e: Editor, items: MenuItem[], id?: string, custom?: MenuCustomization): Resolved[] {
  const out: Resolved[] = [];
  const seen = new Set<string>();
  for (const item of [...items, ...dynamicItems(id).filter((d) => !items.includes(d))]) {
    if (item === '-') {
      if (out.length && out.at(-1)!.kind !== 'separator') out.push({ kind: 'separator' });
      continue;
    }
    if (typeof item === 'string') {
      const c = commands.get(item);
      if (!c || c.hidden || seen.has(item) || (custom && isHiddenInMenus(custom, item))) continue;
      seen.add(item);
      out.push({
        kind: 'command',
        id: c.id,
        label: c.label,
        shortcut: formatShortcut(c.shortcut),
        enabled: c.enabled ? safe(() => c.enabled!(e), false) : true,
        checked: c.checked ? safe(() => c.checked!(e), false) : undefined,
        tag: custom ? menuTag(custom, item) : undefined,
      });
      continue;
    }
    const sub = resolveMenu(e, withContributions(item.id ?? '', item.items), item.id, custom);
    if (sub.some((s) => s.kind !== 'separator')) out.push({ kind: 'submenu', label: item.label, id: item.id, items: sub });
  }
  while (out.length && out[0].kind === 'separator') out.shift();
  while (out.length && out.at(-1)!.kind === 'separator') out.pop();
  return out;
}
function safe<T>(f: () => T, fallback: T) {
  try {
    return f();
  } catch {
    return fallback;
  }
}
function renderItems(items: Resolved[]): string {
  return items
    .map((item) => {
      if (item.kind === 'separator') return '<div class="menu-separator" role="separator"></div>';
      if (item.kind === 'submenu')
        return `<div class="menu-item has-submenu" role="menuitem" aria-haspopup="menu" aria-expanded="false" tabindex="-1"><span class="menu-check"></span><span class="menu-label">${escapeXML(item.label)}</span><span class="menu-arrow">›</span><div class="menu-pop submenu" role="menu">${renderItems(item.items)}</div></div>`;
      return `<div class="menu-item${item.tag ? ` menu-tag-${item.tag}` : ''}" role="${item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}" ${item.checked !== undefined ? `aria-checked="${item.checked}"` : ''} data-command="${item.id}" tabindex="-1" ${item.enabled ? '' : 'aria-disabled="true"'}><span class="menu-check">${item.checked ? '✓' : ''}</span><span class="menu-label">${escapeXML(item.label)}</span><kbd>${escapeXML(item.shortcut)}</kbd></div>`;
    })
    .join('');
}

export class MenuBar {
  private open = -1;
  constructor(
    private e: Editor,
    private el: HTMLElement,
  ) {
    el.setAttribute('role', 'menubar');
    el.innerHTML = menuSkeleton
      .map((m, i) => `<div class="menubar-entry" data-menu="${i}"><button class="menubar-button" role="menuitem" aria-haspopup="menu" aria-expanded="false" tabindex="${i ? -1 : 0}">${m.label}</button><div class="menu-pop" role="menu"></div></div>`)
      .join('');
    el.addEventListener('pointerdown', (ev) => {
      const button = (ev.target as HTMLElement).closest<HTMLElement>('.menubar-button');
      if (!button) return;
      ev.preventDefault();
      const i = Number(button.parentElement!.dataset.menu);
      if (this.open === i) this.close();
      else this.show(i);
    });
    el.addEventListener('pointerover', (ev) => {
      const target = ev.target as HTMLElement;
      const entry = target.closest<HTMLElement>('.menubar-entry');
      if (this.open >= 0 && entry && target.closest('.menubar-button') && Number(entry.dataset.menu) !== this.open)
        this.show(Number(entry.dataset.menu));
      const item = target.closest<HTMLElement>('.menu-item');
      if (item) {
        item.focus({ preventScroll: true });
        this.toggleSubmenus(item);
        if (item.dataset.command) findCommand(item.dataset.command)?.prefetch?.();
      }
    });
    el.addEventListener('click', (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>('.menu-item');
      if (!item || item.classList.contains('has-submenu')) return;
      this.activate(item);
    });
    el.addEventListener('keydown', (ev) => this.key(ev));
    // Menus opened with the pointer do not take focus; Escape must still close them
    // (and must not reach the canvas, where it would deselect).
    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Escape' || this.open < 0 || el.contains(document.activeElement)) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.close();
      },
      true,
    );
    document.addEventListener('pointerdown', (ev) => {
      if (this.open >= 0 && !el.contains(ev.target as Node)) this.close();
    });
  }
  private toggleSubmenus(item: HTMLElement) {
    const parent = item.parentElement!;
    for (const sibling of parent.querySelectorAll<HTMLElement>(':scope > .has-submenu')) {
      const expanded = sibling === item;
      sibling.setAttribute('aria-expanded', String(expanded));
      sibling.classList.toggle('open', expanded);
      // Keep a long submenu inside the window: shift it up when it would overflow.
      const sub = expanded ? sibling.querySelector<HTMLElement>(':scope > .submenu') : null;
      if (sub) {
        sub.style.top = '';
        const r = sub.getBoundingClientRect();
        const over = r.bottom - (window.innerHeight - 4);
        if (over > 0) sub.style.top = `${-5 - Math.min(over, r.top - 4)}px`;
      }
    }
  }
  private activate(item: HTMLElement) {
    if (item.getAttribute('aria-disabled') === 'true') return;
    const id = item.dataset.command!;
    this.close();
    void this.e.runCommand(id);
  }
  show(i: number) {
    const entries = this.el.querySelectorAll<HTMLElement>('.menubar-entry');
    entries.forEach((entry, k) => {
      entry.classList.toggle('open', k === i);
      entry.querySelector('.menubar-button')!.setAttribute('aria-expanded', String(k === i));
    });
    const m = menuSkeleton[i];
    entries[i].querySelector('.menu-pop')!.innerHTML = renderItems(resolveMenu(this.e, withContributions(m.id, m.items), m.id, menuCustomization()));
    this.open = i;
  }
  /** Open the menus leading to a command and highlight it (the Assistant's
   * "Show me"). Returns false when the command is not in the menu bar. */
  reveal(id: string): boolean {
    const custom = menuCustomization();
    const i = menuSkeleton.findIndex((m) => {
      const has = (items: Resolved[]): boolean => items.some((x) => (x.kind === 'command' && x.id === id) || (x.kind === 'submenu' && has(x.items)));
      return has(resolveMenu(this.e, withContributions(m.id, m.items), m.id, custom));
    });
    if (i < 0) return false;
    this.show(i);
    const entry = this.el.querySelectorAll<HTMLElement>('.menubar-entry')[i];
    const item = entry.querySelector<HTMLElement>(`.menu-item[data-command="${CSS.escape(id)}"]`);
    if (!item) return false;
    // Expand each submenu on the way, outermost first.
    const owners: HTMLElement[] = [];
    for (let p = item.parentElement?.closest<HTMLElement>('.has-submenu'); p && entry.contains(p); p = p.parentElement?.closest<HTMLElement>('.has-submenu')) owners.unshift(p);
    for (const o of owners) this.toggleSubmenus(o);
    item.focus({ preventScroll: true });
    item.classList.add('menu-reveal');
    window.setTimeout(() => item.classList.remove('menu-reveal'), 2400);
    return true;
  }
  close() {
    if (this.open < 0) return;
    this.el.querySelectorAll('.menubar-entry').forEach((entry) => {
      entry.classList.remove('open');
      entry.querySelector('.menubar-button')!.setAttribute('aria-expanded', 'false');
    });
    this.open = -1;
  }
  get isOpen() {
    return this.open >= 0;
  }
  private key(ev: KeyboardEvent) {
    const target = ev.target as HTMLElement;
    const count = menuSkeleton.length;
    if (target.classList.contains('menubar-button')) {
      const i = Number(target.parentElement!.dataset.menu);
      const focusTop = (k: number) => {
        const b = this.el.querySelectorAll<HTMLElement>('.menubar-button')[(k + count) % count];
        b.focus();
        if (this.open >= 0) this.show((k + count) % count);
      };
      if (ev.key === 'ArrowRight') focusTop(i + 1);
      else if (ev.key === 'ArrowLeft') focusTop(i - 1);
      else if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
        this.show(i);
        this.el.querySelectorAll<HTMLElement>('.menubar-entry')[i].querySelector<HTMLElement>('.menu-pop > .menu-item')?.focus();
      } else if (ev.key === 'Escape') this.close();
      else return;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    const item = target.closest<HTMLElement>('.menu-item');
    if (!item) return;
    const siblings = [...item.parentElement!.querySelectorAll<HTMLElement>(':scope > .menu-item')];
    const at = siblings.indexOf(item);
    if (ev.key === 'ArrowDown') siblings[(at + 1) % siblings.length].focus();
    else if (ev.key === 'ArrowUp') siblings[(at - 1 + siblings.length) % siblings.length].focus();
    else if (ev.key === 'ArrowRight' && item.classList.contains('has-submenu')) {
      this.toggleSubmenus(item);
      item.querySelector<HTMLElement>('.submenu > .menu-item')?.focus();
    } else if (ev.key === 'ArrowLeft' && item.parentElement!.classList.contains('submenu')) {
      const owner = item.parentElement!.parentElement as HTMLElement;
      owner.classList.remove('open');
      owner.setAttribute('aria-expanded', 'false');
      owner.focus();
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      if (item.classList.contains('has-submenu')) {
        this.toggleSubmenus(item);
        item.querySelector<HTMLElement>('.submenu > .menu-item')?.focus();
      } else this.activate(item);
    } else if (ev.key === 'Escape') {
      const i = this.open;
      this.close();
      this.el.querySelectorAll<HTMLElement>('.menubar-button')[i]?.focus();
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  }
}

/** A context menu built from the same command registry. With `alignRight`,
 * `x` is the menu's right edge (panel menus open leftward from their button). */
export function showContextMenu(e: Editor, x: number, y: number, items: MenuItem[], alignRight = false) {
  document.querySelector('.context-menu')?.remove();
  const resolved = resolveMenu(e, items);
  if (!resolved.length) return;
  const pop = document.createElement('div');
  pop.className = 'menu-pop context-menu';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = renderItems(resolved);
  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(alignRight ? x - r.width : x, innerWidth - r.width - 4))}px`;
  pop.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (ev: Event) => {
    if (!pop.contains(ev.target as Node)) close();
  };
  document.addEventListener('pointerdown', outside, true);
  pop.addEventListener('pointerover', (ev) => {
    const item = (ev.target as HTMLElement).closest<HTMLElement>('.menu-item');
    if (!item) return;
    item.focus({ preventScroll: true });
    if (item.dataset.command) findCommand(item.dataset.command)?.prefetch?.();
    for (const sibling of item.parentElement!.querySelectorAll<HTMLElement>(':scope > .has-submenu'))
      sibling.classList.toggle('open', sibling === item);
  });
  pop.addEventListener('click', (ev) => {
    const item = (ev.target as HTMLElement).closest<HTMLElement>('.menu-item');
    if (!item || item.classList.contains('has-submenu') || item.getAttribute('aria-disabled') === 'true') return;
    close();
    void e.runCommand(item.dataset.command!);
  });
  pop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });
  pop.querySelector<HTMLElement>('.menu-item')?.focus();
}
