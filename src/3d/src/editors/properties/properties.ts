// Properties editor: vertical tab rail + context panels.
import { h, patch, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, type ChangeKind } from '../../app/app';
import { registerEditor, type Area, type Editor } from '../../ui/screen';
import { textField } from '../../ui/widgets';

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

export class Properties implements Editor {
  el: HTMLElement;
  keymaps = ['Property Editor', 'Window', 'Screen'];
  tab = 'OBJECT';
  search = '';
  pinned: string | null = null;
  private rail: HTMLElement;
  private body: HTMLElement;
  private crumbs: HTMLElement;

  constructor(public area: Area, state?: unknown) {
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
    const st = state as { tab?: string } | undefined;
    if (st?.tab) this.tab = st.tab;
  }

  header(): Child {
    return h('div', { class: 'hdr-row' }, h('div', { class: 'hdr-search wide' }, textField('prop-search', this.search, (v) => ((this.search = v), this.update()), { placeholder: 'Search', icon: 'search', live: true })));
  }

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    const requested = (window as unknown as { __propertiesTab?: string }).__propertiesTab;
    if (requested) {
      this.tab = requested;
      delete (window as unknown as { __propertiesTab?: string }).__propertiesTab;
    }
    const tabs = propertiesTabs.filter((t) => t.poll());
    if (!tabs.some((t) => t.id === this.tab)) this.tab = tabs.find((t) => t.id === 'OBJECT')?.id ?? tabs[0]?.id ?? '';
    let lastGroup = -1;
    patch(
      this.rail,
      tabs.map((t) => {
        const sep = t.group !== undefined && t.group !== lastGroup && lastGroup !== -1;
        lastGroup = t.group ?? lastGroup;
        return [
          sep ? h('div', { key: `sep-${t.id}`, class: 'rail-sep' }) : null,
          h('button', { key: t.id, class: { 'rail-tab': true, on: t.id === this.tab }, 'data-tip': t.label, onclick: () => ((this.tab = t.id), this.update()) }, icon(t.icon)),
        ];
      }),
    );
    const tab = tabs.find((t) => t.id === this.tab);
    const ob = app.activeObject;
    patch(this.crumbs, [
      ['RENDER', 'OUTPUT', 'VIEW_LAYER', 'SCENE', 'WORLD', 'COLLECTION', 'TOOL'].includes(this.tab)
        ? h('span', { class: 'crumb' }, icon(this.tab === 'WORLD' ? 'world' : 'scene_data'), this.tab === 'WORLD' ? `Scene  ›  ${app.doc.scene.world ? app.doc.worlds[app.doc.scene.world]?.name : ''}` : app.doc.scene.name)
        : ob
          ? h('span', { class: 'crumb' }, icon('object'), ob.name, this.tab === 'DATA' && ob.data ? h('span', { class: 'crumb-sub' }, ' › ', (app.doc.meshes[ob.data] ?? app.doc.curves[ob.data] ?? app.doc.lights[ob.data] ?? app.doc.cameras[ob.data] ?? app.doc.armatures[ob.data] ?? app.doc.metaballs?.[ob.data])?.name ?? '') : null)
          : null,
    ]);
    const content = tab ? tab.draw(this) : h('div', { class: 'prop-empty' }, 'No context');
    patch(this.body, this.search ? filterContent(content, this.search) : content);
  }

  serialize() {
    return { tab: this.tab };
  }

  dispose() {}
}

/** Very small search: hide panels whose text does not match (applied after render). */
function filterContent(c: Child, _q: string): Child {
  requestAnimationFrame(() => {
    const q = _q.toLowerCase();
    document.querySelectorAll('.prop-body .panel').forEach((p) => {
      const txt = p.textContent?.toLowerCase() ?? '';
      (p as HTMLElement).style.display = txt.includes(q) ? '' : 'none';
    });
  });
  return c;
}

registerEditor({ id: 'PROPERTIES', label: 'Properties', icon: 'properties', group: 'Data', create: (a, s) => new Properties(a, s) });
