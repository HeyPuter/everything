// Properties editor: vertical tab rail + context panels. Tabs cycle with Ctrl+wheel / Ctrl+Tab,
// Ctrl+F searches every panel of every tab, and panels can be reordered by their grip.
import { h, patch, type Child, type VNode } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators, operators, onAppReady, type ChangeKind, type OpContext } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { registerEditor, type Area, type Editor } from '../../ui/screen';
import { textField, setPanelSearch } from '../../ui/widgets';
import './properties.css';

export interface PropertiesTab {
  id: string;
  label: string;
  icon: string;
  /** whether the tab is available in the current context */
  poll: () => boolean;
  draw: (p: Properties) => Child;
  /** group separator before this tab */
  group?: number;
}

export const propertiesTabs: PropertiesTab[] = [];
export function registerTab(t: PropertiesTab) {
  propertiesTabs.push(t);
}

/** Visible text of a vnode tree (labels, values). */
function textOf(c: Child): string {
  if (c === null || c === undefined || c === false) return '';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(textOf).join(' ');
  if (c.text !== undefined) return c.text;
  return c.children.map(textOf).join(' ');
}

function flatten(c: Child, out: VNode[] = []): VNode[] {
  if (c === null || c === undefined || c === false) return out;
  if (Array.isArray(c)) c.forEach((x) => flatten(x, out));
  else if (typeof c === 'string' || typeof c === 'number') out.push(h('span', null, String(c)));
  else out.push(c);
  return out;
}

const isPanelNode = (v: VNode) => v.tag === 'section' && typeof v.attrs['data-panel'] === 'string';

export class Properties implements Editor {
  el: HTMLElement;
  keymaps = ['Property Editor', 'Window', 'Screen'];
  tab = 'OBJECT';
  search = '';
  pinned: string | null = null;
  /** user panel order per tab (panel ids) */
  panelOrder: Record<string, string[]> = {};
  private rail: HTMLElement;
  private body: HTMLElement;
  private crumbs: HTMLElement;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'properties';
    this.rail = document.createElement('div');
    this.rail.className = 'prop-rail';
    const main = document.createElement('div');
    main.className = 'prop-main';
    this.crumbs = document.createElement('div');
    this.crumbs.className = 'prop-crumbs';
    this.body = document.createElement('div');
    this.body.className = 'prop-body';
    main.append(this.crumbs, this.body);
    this.el.append(this.rail, main);
    const st = state as { tab?: string; panelOrder?: Record<string, string[]> } | undefined;
    if (st?.tab) this.tab = st.tab;
    if (st?.panelOrder) this.panelOrder = { ...st.panelOrder };
    // Ctrl+wheel cycles the tabs (number fields and menus use it themselves and stop it)
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
        e.preventDefault();
        this.cycleTab(e.deltaY > 0 ? 1 : -1);
      },
      { passive: false },
    );
    this.body.addEventListener('pointerdown', (e) => this.onGripDown(e));
  }

  header(): Child {
    return h(
      'div',
      { class: 'hdr-row' },
      h(
        'div',
        { class: 'hdr-search wide' },
        textField('prop-search', this.search, (v) => this.setSearch(v), { placeholder: 'Search (Ctrl F)', icon: 'search', live: true, className: 'prop-search' }),
      ),
    );
  }

  availableTabs() {
    return propertiesTabs.filter((t) => {
      try {
        return t.poll();
      } catch {
        return false;
      }
    });
  }

  setTab(id: string) {
    this.tab = id;
    this.update();
    this.body.scrollTop = 0;
  }

  /** Step to the next / previous available tab. */
  cycleTab(dir: number) {
    const tabs = this.availableTabs();
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.id === this.tab);
    const n = tabs.length;
    this.setTab(tabs[((((i < 0 ? 0 : i) + dir) % n) + n) % n].id);
  }

  setSearch(v: string) {
    this.search = v;
    this.update();
  }

  focusSearch() {
    const input = this.area.headerEl.querySelector('.prop-search input') as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }

  /** Draw a tab (panels forced open while searching). */
  private drawTab(t: PropertiesTab): Child {
    setPanelSearch(this.search.trim());
    try {
      return t.draw(this);
    } finally {
      setPanelSearch('');
    }
  }

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    const requested = (window as unknown as { __propertiesTab?: string }).__propertiesTab;
    if (requested) {
      this.tab = requested;
      delete (window as unknown as { __propertiesTab?: string }).__propertiesTab;
    }
    const tabs = this.availableTabs();
    if (!tabs.some((t) => t.id === this.tab)) this.tab = tabs.find((t) => t.id === 'OBJECT')?.id ?? tabs[0]?.id ?? '';
    const q = this.search.trim().toLowerCase();
    // while searching, tabs without a match are dimmed
    const misses = new Set<string>();
    if (q) for (const t of tabs) if (t.id !== this.tab && !textOf(this.drawTab(t)).toLowerCase().includes(q)) misses.add(t.id);
    let lastGroup = -1;
    patch(
      this.rail,
      tabs.map((t) => {
        const sep = t.group !== undefined && t.group !== lastGroup && lastGroup !== -1;
        lastGroup = t.group ?? lastGroup;
        return [
          sep ? h('div', { key: `sep-${t.id}`, class: 'rail-sep' }) : null,
          h(
            'button',
            {
              key: t.id,
              class: { 'rail-tab': true, on: t.id === this.tab, 'search-miss': misses.has(t.id) },
              'data-tip': `${t.label}\nCtrl+wheel or Ctrl+Tab to cycle tabs`,
              'data-tab': t.id,
              onclick: () => this.setTab(t.id),
            },
            icon(t.icon),
          ),
        ];
      }),
    );
    const tab = tabs.find((t) => t.id === this.tab);
    const ob = app.activeObject;
    patch(this.crumbs, [
      ['RENDER', 'OUTPUT', 'VIEW_LAYER', 'SCENE', 'WORLD', 'COLLECTION', 'TOOL'].includes(this.tab)
        ? h(
            'span',
            { class: 'crumb' },
            icon(this.tab === 'WORLD' ? 'world' : 'scene_data'),
            this.tab === 'WORLD' ? `Scene  ›  ${app.doc.scene.world ? app.doc.worlds[app.doc.scene.world]?.name : ''}` : app.doc.scene.name,
          )
        : ob
          ? h(
              'span',
              { class: 'crumb' },
              icon('object'),
              ob.name,
              this.tab === 'DATA' && ob.data
                ? h(
                    'span',
                    { class: 'crumb-sub' },
                    ' › ',
                    (app.doc.meshes[ob.data] ?? app.doc.curves[ob.data] ?? app.doc.lights[ob.data] ?? app.doc.cameras[ob.data] ?? app.doc.armatures[ob.data])?.name ?? '',
                  )
                : null,
            )
          : null,
    ]);
    const content = tab ? this.drawTab(tab) : h('div', { class: 'prop-empty' }, 'No context');
    patch(this.body, this.ordered(content));
    this.applySearch(q);
  }

  /** Apply the user's panel order to the top-level panels of the current tab. */
  private ordered(content: Child): Child {
    const order = this.panelOrder[this.tab];
    if (!order?.length) return content;
    const flat = flatten(content);
    const slots = flat.map((v, i) => (isPanelNode(v) ? i : -1)).filter((i) => i >= 0);
    const panels = slots.map((i) => flat[i]);
    const rank = (v: VNode) => {
      const r = order.indexOf(v.attrs['data-panel'] as string);
      return r < 0 ? order.length + panels.indexOf(v) : r;
    };
    const sorted = [...panels].sort((a, b) => rank(a) - rank(b));
    slots.forEach((slot, k) => (flat[slot] = sorted[k]));
    return flat;
  }

  /** Hide panels without a match and highlight matching rows. */
  private applySearch(q: string) {
    const body = this.body;
    body.classList.toggle('searching', !!q);
    for (const p of body.querySelectorAll<HTMLElement>(':scope > .panel')) p.style.display = !q || (p.textContent ?? '').toLowerCase().includes(q) ? '' : 'none';
    for (const r of body.querySelectorAll<HTMLElement>('.split-row, .checkbox')) {
      const label = r.querySelector('.sr-label, .cb-label')?.textContent ?? '';
      r.classList.toggle('search-hl', !!q && !!label && label.toLowerCase().includes(q));
    }
  }

  // ---------------------------------------------------------------------------
  // panel reordering

  private onGripDown(e: PointerEvent) {
    const grip = (e.target as HTMLElement).closest('.ph-grip');
    if (!grip || e.button !== 0) return;
    const section = grip.closest('.panel') as HTMLElement | null;
    if (!section || section.parentElement !== this.body) return;
    e.preventDefault();
    e.stopPropagation();
    const id = section.dataset.panel!;
    const siblings = () => [...this.body.querySelectorAll<HTMLElement>(':scope > .panel')].filter((p) => p.style.display !== 'none');
    const line = document.createElement('div');
    line.className = 'panel-drop-line';
    this.body.append(line);
    section.classList.add('dragging');
    let target = -1;
    const move = (ev: PointerEvent) => {
      const list = siblings();
      target = list.length;
      for (let i = 0; i < list.length; i++) {
        const r = list[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          target = i;
          break;
        }
      }
      const br = this.body.getBoundingClientRect();
      const ref = list[target] ?? list[list.length - 1];
      const rr = ref.getBoundingClientRect();
      line.style.top = `${(list[target] ? rr.top : rr.bottom) - br.top + this.body.scrollTop - 2}px`;
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      line.remove();
      section.classList.remove('dragging');
      if (target < 0) return;
      const ids = siblings().map((p) => p.dataset.panel!);
      const from = ids.indexOf(id);
      if (from < 0) return;
      ids.splice(from, 1);
      ids.splice(target > from ? target - 1 : target, 0, id);
      // keep the order of panels that are hidden right now
      const prev = this.panelOrder[this.tab] ?? [];
      this.panelOrder[this.tab] = [...ids, ...prev.filter((x) => !ids.includes(x))];
      this.update();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }

  serialize() {
    return { tab: this.tab, panelOrder: this.panelOrder };
  }

  dispose() {}
}

registerEditor({ id: 'PROPERTIES', label: 'Properties', icon: 'properties', group: 'Data', create: (a, s) => new Properties(a, s) });

// ---------------------------------------------------------------------------
// operators and keymap

function propsEditor(ctx: OpContext): Properties | null {
  const ed = ctx.area?.editor;
  return ed instanceof Properties ? ed : null;
}

registerOperators([
  {
    idname: 'buttons.start_filter',
    label: 'Filter',
    description: 'Start searching the properties of every tab',
    poll: (ctx) => !!propsEditor(ctx),
    exec: (ctx) => propsEditor(ctx)!.focusSearch(),
    undo: false,
  },
  {
    idname: 'buttons.clear_filter',
    label: 'Clear Filter',
    description: 'Clear the properties search',
    poll: (ctx) => !!propsEditor(ctx)?.search,
    exec: (ctx) => {
      const p = propsEditor(ctx)!;
      p.search = '';
      p.update();
      p.area.drawHeader();
    },
    undo: false,
  },
]);

// Cycling the context of the editor under the mouse (Properties tabs). Registered once the app is
// ready so another module can provide a broader implementation first.
onAppReady(() => {
  if (operators.has('screen.space_context_cycle')) return;
  registerOperators([
    {
      idname: 'screen.space_context_cycle',
      label: 'Cycle Space Context',
      description: 'Cycle through the tabs of the editor under the mouse',
      props: [
        {
          id: 'direction',
          label: 'Direction',
          type: 'enum',
          default: 'NEXT',
          items: [
            ['PREV', 'Previous'],
            ['NEXT', 'Next'],
          ],
        },
      ],
      poll: (ctx) => !!propsEditor(ctx),
      exec: (ctx, p) => propsEditor(ctx)!.cycleTab(p.direction === 'PREV' ? -1 : 1),
      undo: false,
    },
  ]);
});

addKeys('Property Editor', [
  { key: 'F', ctrl: true, op: 'buttons.start_filter' },
  { key: 'F', alt: true, op: 'buttons.clear_filter' },
  { key: 'TAB', ctrl: true, op: 'screen.space_context_cycle', props: { direction: 'NEXT' } },
  { key: 'TAB', ctrl: true, shift: true, op: 'screen.space_context_cycle', props: { direction: 'PREV' } },
]);
