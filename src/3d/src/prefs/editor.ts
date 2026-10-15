// Preferences editor (also hosted in the floating Preferences window): a section list on the
// left with the preferences menu at its bottom, and the active section's panels on the right.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu } from '../ui/menu';
import { setPanelSearch } from '../ui/widgets';
import { prefs } from '../app/prefs';
import { setPref, saveAllPrefs, revertPrefs, prefsDirty } from './store';
import { KeymapView } from './keymap_ui';
import { onKeyconfigChange } from './keyconfig';

export interface SectionCtx {
  redraw(): void;
  editor: PreferencesEditor;
}

export interface PrefSection {
  id: string;
  label: string;
  /** sections with the same group are listed together */
  group: number;
  draw(ctx: SectionCtx): Child;
}

export const prefSections: PrefSection[] = [];

export function registerPrefSection(s: PrefSection) {
  const i = prefSections.findIndex((x) => x.id === s.id);
  if (i >= 0) prefSections[i] = s;
  else prefSections.push(s);
}

const ORDER = ['INTERFACE', 'THEMES', 'VIEWPORT', 'LIGHTS', 'EDITING', 'ANIMATION', 'ADDONS', 'INPUT', 'NAVIGATION', 'KEYMAP', 'SYSTEM', 'SAVE_LOAD', 'FILE_PATHS'];
export type Section = string;

function sections() {
  return [...prefSections].sort((a, b) => a.group - b.group || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

export class PreferencesEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Window', 'Screen'];
  section: Section = 'INTERFACE';
  keymapView = new KeymapView(() => this.draw());
  /** text of the search over all sections (Keymap has its own search) */
  search = '';
  private unsub: () => void;

  constructor(
    public area: Area | null,
    state?: unknown,
  ) {
    const st = (state ?? {}) as { section?: Section };
    if (st.section && ORDER.includes(st.section)) this.section = st.section;
    this.el = document.createElement('div');
    this.el.className = 'prefs-editor';
    this.unsub = onKeyconfigChange(() => this.draw());
    this.draw();
  }

  header(): Child {
    return h('div', { class: 'hdr-row' }, h('span', { class: 'prefs-hdr-title' }, 'Preferences'));
  }

  setSection(s: Section) {
    this.section = s;
    this.el.querySelector('.prefs-main')?.scrollTo(0, 0);
    this.draw();
  }

  private menu(e: PointerEvent) {
    e.preventDefault();
    openMenu(
      [
        { label: 'Auto-Save Preferences', checked: prefs.use_preferences_save, action: () => setPref('use_preferences_save', !prefs.use_preferences_save) },
        { separator: true },
        { label: 'Revert to Saved Preferences', icon: 'km_restore', action: () => (revertPrefs(), app.report('INFO', 'Preferences reverted to the saved state')) },
        { label: 'Load Factory Preferences', icon: 'file_refresh', op: 'wm.read_factory_userpref' },
        { separator: true },
        { label: 'Save Preferences', icon: 'prefs_save', op: 'wm.save_userpref' },
      ],
      e.currentTarget as HTMLElement,
    );
  }

  draw() {
    const list = sections();
    if (!list.some((s) => s.id === this.section) && list.length) this.section = list[0].id;
    const cur = list.find((s) => s.id === this.section);
    const q = this.search.trim().toLowerCase();
    const searching = !!q;
    const ctx: SectionCtx = { redraw: () => this.draw(), editor: this };
    // panels show their contents while searching
    setPanelSearch(q);
    const dirty = !prefs.use_preferences_save && prefsDirty();
    let lastGroup = -1;
    patch(this.el, [
      h(
        'nav',
        { class: 'prefs-nav', 'aria-label': 'Preference sections' },
        h(
          'label',
          { class: 'text-field prefs-search' },
          icon('search'),
          h('input', {
            value: this.search,
            placeholder: 'Search',
            spellcheck: 'false',
            'aria-label': 'Search preferences',
            oninput: (e: Event) => ((this.search = (e.target as HTMLInputElement).value), this.draw()),
            onkeydown: (e: KeyboardEvent) => {
              e.stopPropagation();
              if (e.key === 'Escape') ((this.search = ''), (e.target as HTMLInputElement).blur(), this.draw());
            },
          }),
        ),
        h(
          'div',
          { class: 'prefs-nav-list' },
          list.map((s) => {
            const gap = lastGroup >= 0 && s.group !== lastGroup;
            lastGroup = s.group;
            return h('button', { key: s.id, 'data-section': s.id, class: { 'prefs-nav-btn': true, on: !searching && this.section === s.id, gap }, 'aria-current': this.section === s.id ? 'page' : null, onclick: () => ((this.search = ''), this.setSection(s.id)) }, s.label);
          }),
        ),
        h('div', { class: 'hdr-spacer' }),
        dirty ? h('button', { class: 'btn prefs-save', onclick: () => saveAllPrefs() }, 'Save Preferences') : null,
        h(
          'button',
          {
            class: 'prefs-menu-btn',
            'data-tip': 'Preferences\nAuto-save, save, revert or load factory preferences',
            'aria-label': 'Preferences menu',
            onpointerdown: (e: PointerEvent) => this.menu(e),
          },
          icon('collapsemenu'),
          dirty ? h('span', { class: 'prefs-unsaved' }, 'Unsaved changes') : null,
        ),
      ),
      h(
        'div',
        { class: { 'prefs-main': true, searching }, 'data-section': searching ? 'SEARCH' : this.section },
        searching
          ? list.filter((s) => s.id !== 'KEYMAP').map((s) => h('div', { key: s.id, class: 'prefs-search-sec', 'data-sec': s.id }, h('div', { class: 'prefs-search-title' }, s.label), s.draw(ctx)))
          : cur
            ? cur.draw(ctx)
            : null,
      ),
    ]);
    setPanelSearch('');
    if (searching) this.applySearch(q);
  }

  /** Show only the rows and panels that match the search; dim sections without a match. */
  private applySearch(q: string) {
    const main = this.el.querySelector('.prefs-main');
    if (!main) return;
    const rowSel = '.split-row, .prefs-info-row, .sl-light, .th-row, .ad-item';
    for (const sec of main.querySelectorAll<HTMLElement>('.prefs-search-sec')) {
      let any = false;
      for (const p of sec.querySelectorAll<HTMLElement>(':scope > .panel')) {
        const title = (p.querySelector(':scope > .panel-header .ph-title')?.textContent ?? '').toLowerCase();
        const titleHit = title.includes(q);
        let hits = 0;
        for (const r of p.querySelectorAll<HTMLElement>(rowSel)) {
          const hit = (r.textContent ?? '').toLowerCase().includes(q);
          r.classList.toggle('search-hl', hit);
          r.style.display = titleHit || hit ? '' : 'none';
          if (hit) hits++;
        }
        // sub-panels without a match collapse away too
        for (const sp of p.querySelectorAll<HTMLElement>('.panel.sub')) sp.style.display = titleHit || (sp.textContent ?? '').toLowerCase().includes(q) ? '' : 'none';
        for (const n of p.querySelectorAll<HTMLElement>('.prefs-note')) n.style.display = titleHit ? '' : 'none';
        const show = titleHit || hits > 0;
        p.style.display = show ? '' : 'none';
        any ||= show;
      }
      sec.style.display = any ? '' : 'none';
      this.el.querySelector<HTMLElement>(`.prefs-nav-btn[data-section="${sec.dataset.sec}"]`)?.classList.toggle('search-miss', !any);
    }
  }

  update(kinds: Set<ChangeKind>) {
    // (a focused text input keeps its text through redraws, see ui/h.ts)
    if (kinds.has('ui') || kinds.has('doc')) this.draw();
  }

  serialize() {
    return { section: this.section };
  }

  dispose() {
    this.unsub();
  }
}

registerEditor({ id: 'PREFERENCES', label: 'Preferences', icon: 'preferences', group: 'Data', create: (a, s) => new PreferencesEditor(a, s) });
