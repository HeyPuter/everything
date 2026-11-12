import type { Editor } from '../editor';
import { escapeXML } from '../model/assets';
import { svg } from './icons';
import { menuButton, updatePanel } from './dock';
import { panels, type Panel } from './registry';

type State = { open: boolean; collapsed: boolean; height: number; active?: string };
const storageKey = 'photo-studio-bottom-dock';
const minHeight = 90;

function load(): State {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) ?? '');
    if (v && typeof v === 'object') return { open: !!v.open, collapsed: !!v.collapsed, height: Number(v.height) || 210, active: typeof v.active === 'string' ? v.active : undefined };
  } catch {
    /* Layout persistence is optional. */
  }
  return { open: false, collapsed: false, height: 210 };
}

/** A horizontal panel area under the canvas (Timeline). It is tabbed like the
 * dock groups, can be collapsed to its tab bar, resized from its top edge and
 * closed; Window menu entries open it again. */
export class BottomDock {
  private state = load();
  private mounted = new Map<string, HTMLElement>();
  constructor(
    private e: Editor,
    private el: HTMLElement,
  ) {
    el.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const tab = t.closest<HTMLElement>('[data-bottom-tab]');
      if (tab) return this.show(tab.dataset.bottomTab!);
      const menu = t.closest<HTMLElement>('[data-bottom-menu]');
      if (menu) return e.dock.openMenu(menu.dataset.bottomMenu!, menu);
      if (t.closest('[data-bottom-collapse]')) return this.setCollapsed(!this.state.collapsed);
      if (t.closest('[data-bottom-close]')) this.close();
    });
    el.addEventListener('dblclick', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('.bottom-dock-tabs') && !t.closest('button:not([data-bottom-tab])')) this.setCollapsed(!this.state.collapsed);
    });
    this.bindResize();
  }
  private save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.state));
    } catch {
      /* Optional. */
    }
  }
  private list() {
    return [...panels.values()].filter((p) => p.location === 'bottom');
  }
  private active(): Panel | undefined {
    const list = this.list();
    return list.find((p) => p.id === this.state.active) ?? list[0];
  }
  isVisible(id: string) {
    return this.state.open && this.active()?.id === id;
  }
  /** Open a panel (toggle closes it when it is already showing). */
  show(id: string, toggle = false) {
    if (toggle && this.isVisible(id)) return this.close();
    this.state.open = true;
    this.state.active = id;
    this.state.collapsed = false;
    this.changed();
  }
  close() {
    this.state.open = false;
    this.changed();
  }
  private setCollapsed(v: boolean) {
    this.state.collapsed = v;
    this.changed();
  }
  private changed() {
    this.save();
    this.render();
    // The canvas area changed size: refresh rulers and overlays.
    this.e.view();
    this.e.overlay();
  }
  private body(p: Panel) {
    let el = this.mounted.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'panel-body bottom-panel-body';
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
    const list = this.list();
    const active = this.active();
    const open = this.state.open && !!active;
    this.el.hidden = !open;
    for (const body of this.mounted.values()) body.remove();
    if (!open || !active) return;
    this.el.classList.toggle('collapsed', this.state.collapsed);
    this.el.style.setProperty('--bottom-height', `${Math.max(minHeight, this.state.height)}px`);
    this.el.innerHTML = `<div class="bottom-resizer" aria-hidden="true"></div><div class="panel-tabs bottom-dock-tabs" role="tablist" aria-label="Bottom panels">${list
      .map((p) => `<button role="tab" data-bottom-tab="${p.id}" aria-selected="${p.id === active.id}" aria-controls="panel-${p.id}">${escapeXML(p.title)}</button>`)
      .join('')}<span class="panel-tabs-spacer"></span>${menuButton(active, 'data-bottom-menu')}<button class="panel-menu-button" data-bottom-collapse aria-expanded="${!this.state.collapsed}" aria-label="${this.state.collapsed ? 'Expand' : 'Collapse'} ${escapeXML(active.title)}" title="${this.state.collapsed ? 'Expand' : 'Collapse'}">${svg(this.state.collapsed ? 'chevron-right' : 'chevron-down', 15)}</button><button class="panel-menu-button" data-bottom-close aria-label="Close ${escapeXML(active.title)}" title="Close">${svg('x', 15)}</button></div><div class="bottom-dock-slot"></div>`;
    if (this.state.collapsed) return;
    const body = this.body(active);
    this.el.querySelector('.bottom-dock-slot')!.append(body);
    updatePanel(this.e, active, body);
  }
  update() {
    for (const [id, el] of this.mounted) if (el.isConnected) updatePanel(this.e, panels.get(id), el);
  }
  private bindResize() {
    let drag: { start: number; height: number; id: number } | undefined;
    this.el.addEventListener('pointerdown', (ev) => {
      if (!(ev.target as HTMLElement).closest('.bottom-resizer') || this.state.collapsed) return;
      drag = { start: ev.clientY, height: this.el.getBoundingClientRect().height, id: ev.pointerId };
      (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    this.el.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const max = Math.max(minHeight, (this.el.parentElement?.getBoundingClientRect().height ?? 600) - 160);
      this.state.height = Math.round(Math.max(minHeight, Math.min(max, drag.height - (ev.clientY - drag.start))));
      this.el.style.setProperty('--bottom-height', `${this.state.height}px`);
      this.e.view();
    });
    const end = () => {
      if (!drag) return;
      drag = undefined;
      this.save();
      this.e.overlay();
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }
}
