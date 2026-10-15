// Preferences editor (also hosted in the floating Preferences window): a section list on the
// left with the preferences menu at its bottom, and the active section's panels on the right.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu } from '../ui/menu';
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
    const dirty = !prefs.use_preferences_save && prefsDirty();
    let lastGroup = -1;
    patch(this.el, [
      h(
        'nav',
        { class: 'prefs-nav', 'aria-label': 'Preference sections' },
        h(
          'div',
          { class: 'prefs-nav-list' },
          list.map((s) => {
            const gap = lastGroup >= 0 && s.group !== lastGroup;
            lastGroup = s.group;
            return h('button', { key: s.id, 'data-section': s.id, class: { 'prefs-nav-btn': true, on: this.section === s.id, gap }, 'aria-current': this.section === s.id ? 'page' : null, onclick: () => this.setSection(s.id) }, s.label);
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
      h('div', { class: 'prefs-main', 'data-section': this.section }, cur ? cur.draw({ redraw: () => this.draw(), editor: this }) : null),
    ]);
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
