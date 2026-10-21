// Preferences ▸ Keymap: presets, keyconfig options, search by name or key press and a
// tree of keymaps whose items can be rebound, re-targeted, disabled, added and removed.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, operators, type PropDef } from '../app/app';
import { keymaps, keyLabel, keyName, MODIFIER_KEYS, type KeyItem, type KeyValue } from '../app/keymap';
import { checkbox, enumMenu, enumRow, numberField, panel, textField, type EnumItem } from '../ui/widgets';
import { openMenu, openSearch, promptText } from '../ui/menu';
import { splitRow } from '../ui/props';
import { download, pickFile } from '../io/native';
import { keyconfig, keyconfigChanged, presetChoices, currentPresetChoice, choosePreset, saveUserPreset, removeUserPreset, exportKeyconfigText, importKeyconfigText, userPresets } from './keyconfig';
import type { Edit, ItemFields } from './keyconfig_core';

/** Parent keymap of each nested keymap (the tree shown in the editor). */
const PARENT: Record<string, string> = {
  Frames: 'Screen',
  'Object Mode': '3D View',
  'Object Non-modal': '3D View',
  Mesh: '3D View',
  Curve: '3D View',
  Armature: '3D View',
  Font: '3D View',
  Lattice: '3D View',
  Metaball: '3D View',
  Pose: '3D View',
  Sculpt: '3D View',
  'Vertex Paint': '3D View',
  'Weight Paint': '3D View',
  'Image Paint': '3D View',
  'Grease Pencil': '3D View',
  'Image Generic': 'Image',
  'UV Editor': 'Image',
  'Node Generic': 'Node Editor',
  Compositor: 'Node Editor',
  Dopesheet: 'Animation',
  'Dopesheet Grease Pencil': 'Animation',
  'Graph Editor': 'Animation',
  'NLA Editor': 'Animation',
  Drivers: 'Animation',
  'Animation Channels': 'Animation',
  Markers: 'Animation',
  SequencerCommon: 'Sequencer',
  SequencerPreview: 'Sequencer',
  'Sequencer Channels': 'Sequencer',
  'Clip Editor': 'Clip',
  'Clip Graph Editor': 'Clip',
  'Clip Dopesheet Editor': 'Clip',
};
const TOP_ORDER = ['Window', 'Screen', 'User Interface', '3D View', 'Image', 'Node Editor', 'Animation', 'Sequencer', 'Clip', 'Text', 'Console', 'Info', 'Outliner', 'Property Editor', 'File Browser'];

const VALUES: EnumItem[] = [
  { value: 'PRESS', label: 'Press', description: 'Runs when the key goes down' },
  { value: 'RELEASE', label: 'Release', description: 'Runs when the key comes back up' },
  { value: 'CLICK', label: 'Click', description: 'Runs on a quick press and release with no other key in between' },
  { value: 'DOUBLE_CLICK', label: 'Double Click', description: 'Runs on the second of two quick presses' },
];

const KEY_NAMES: string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `NUMPAD_${i}`),
  'NUMPAD_PERIOD', 'NUMPAD_PLUS', 'NUMPAD_MINUS', 'NUMPAD_ASTERIX', 'NUMPAD_SLASH', 'NUMPAD_ENTER',
  'TAB', 'SPACE', 'RET', 'ESC', 'BACK_SPACE', 'DEL', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN',
  'LEFT_ARROW', 'RIGHT_ARROW', 'UP_ARROW', 'DOWN_ARROW',
  'ACCENT_GRAVE', 'MINUS', 'EQUAL', 'LEFT_BRACKET', 'RIGHT_BRACKET', 'SEMI_COLON', 'QUOTE', 'COMMA', 'PERIOD', 'SLASH', 'BACK_SLASH',
  'INSERT', 'APP', 'MEDIA_PLAY', 'MEDIA_STOP', 'MEDIA_FIRST', 'MEDIA_LAST',
  'WHEELUPMOUSE', 'WHEELDOWNMOUSE',
  ...MODIFIER_KEYS,
  'NONE',
];

export function itemLabel(k: KeyItem): string {
  if (!k.op) return k.menuTitle ? `${k.menuTitle} Menu` : k.action ? 'Built-in Action' : 'Nothing';
  const op = operators.get(k.op);
  let label = op?.label ?? k.op;
  if (k.props && Object.keys(k.props).length) {
    const v = Object.entries(k.props)
      .map(([key, x]) => (typeof x === 'string' ? (/^[A-Z0-9_]+$/.test(x) ? x.charAt(0) + x.slice(1).toLowerCase().replace(/_/g, ' ') : x) : typeof x === 'boolean' ? (x ? key.replace(/^use_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '') : typeof x === 'number' ? String(Math.round(x * 1000) / 1000) : ''))
      .filter(Boolean)
      .join(', ');
    if (v) label += ` (${v})`;
  }
  return label;
}

/** Text of a binding for display, with the event value when it is not a plain press. */
export function bindingLabel(k: Pick<KeyItem, 'key' | 'ctrl' | 'shift' | 'alt' | 'any' | 'value'>) {
  if (k.key === 'NONE') return '—';
  const base = keyLabel({ ...k, op: '' } as KeyItem);
  const v = k.value && k.value !== 'PRESS' ? ` (${VALUES.find((x) => x.value === k.value)?.label})` : '';
  return `${k.any ? 'Any ' : ''}${base}${v}`;
}

const MOD_WORDS: Record<string, 'ctrl' | 'shift' | 'alt'> = { ctrl: 'ctrl', control: 'ctrl', cmd: 'ctrl', command: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt' };

/** Match "ctrl shift z" style queries against an item's binding. `exact` requires the same modifiers. */
export function matchKeyQuery(k: KeyItem, query: string, exact = false): boolean {
  const words = query.toLowerCase().split(/[\s+]+/).filter(Boolean);
  if (!words.length) return true;
  const mods = { ctrl: false, shift: false, alt: false };
  const rest: string[] = [];
  for (const w of words) {
    const m = MOD_WORDS[w];
    if (m) mods[m] = true;
    else rest.push(w);
  }
  for (const m of ['ctrl', 'shift', 'alt'] as const) {
    if (mods[m] && !k[m] && !k.any) return false;
    if (exact && !mods[m] && k[m]) return false;
  }
  if (!rest.length) return true;
  const keyText = rest.join(' ');
  const pretty = keyLabel({ key: k.key, op: '' }).toLowerCase();
  return k.key.toLowerCase() === keyText || pretty === keyText || (!exact && (k.key.toLowerCase().startsWith(keyText) || pretty.startsWith(keyText)));
}

function propEditor(id: string, d: PropDef, value: unknown, set: (v: unknown) => void): Child {
  const label = d.label ?? d.id;
  switch (d.type) {
    case 'bool':
      return splitRow('', checkbox(id, label, !!value, (v) => set(v)), undefined, 'check');
    case 'int':
    case 'float':
      return splitRow(label, numberField({ id, value: Number(value ?? 0), min: d.min, max: d.max, softMin: d.softMin, softMax: d.softMax, int: d.type === 'int', precision: d.precision ?? 3, unit: d.subtype === 'angle' ? 'angle' : 'none', set: (v, f) => f && set(v) }));
    case 'enum':
      return splitRow(label, enumMenu(id, (d.items ?? []).map(([v, l, desc]) => ({ value: v, label: l, description: desc })), String(value ?? ''), (v) => set(v)));
    case 'string':
      return splitRow(label, textField(id, String(value ?? ''), (v) => set(v)));
    default:
      return splitRow(
        label,
        textField(id, JSON.stringify(value ?? d.default), (v) => {
          try {
            set(JSON.parse(v));
          } catch {
            app.report('ERROR', `${label}: enter a JSON value such as [0, 0, 1]`);
          }
        }),
      );
  }
}

export class KeymapView {
  search = '';
  searchMode: 'NAME' | 'KEY' = 'NAME';
  /** search text came from a key press: match modifiers exactly */
  exactKey = false;
  recording = false;
  capturing: KeyItem | null = null;
  /** ids of items whose details are shown */
  expanded = new Set<string>();

  constructor(private redraw: () => void) {}

  private changed() {
    keyconfigChanged();
    app.changed('ui');
    this.redraw();
  }

  private edit(k: KeyItem, e: Edit) {
    keyconfig.edit(k, e);
    this.changed();
  }

  body(): Child {
    return [this.presetBar(), this.optionsPanel(), this.searchBar(), this.tree()];
  }

  // ------------------------------------------------------------------ presets

  private presetBar(): Child {
    const cur = currentPresetChoice();
    const isUser = cur.startsWith('user:');
    return h(
      'div',
      { class: 'km-toolbar km-presets' },
      enumMenu('km-preset', presetChoices(), cur, (v) => (choosePreset(v), app.changed('ui'), this.redraw()), { className: 'km-preset-menu', tip: 'Keymap Preset\nStart from a built-in layout or a saved key configuration' }),
      h(
        'button',
        {
          class: 'btn icon-btn',
          'data-tip': 'Save Preset\nSave the current key configuration as a named preset',
          'aria-label': 'Save keymap preset',
          onclick: (e: MouseEvent) =>
            promptText('Preset Name', keyconfig.data.name ?? 'My Keymap', (name) => {
              const n = name.trim();
              if (!n) return;
              saveUserPreset(n);
              app.report('INFO', `Saved keymap preset "${n}"`);
              this.redraw();
            }, { x: e.clientX, y: e.clientY }),
        },
        icon('add'),
      ),
      h(
        'button',
        {
          class: 'btn icon-btn',
          disabled: !isUser,
          'data-tip': 'Remove Preset\nDelete the selected saved preset (the current bindings stay)',
          'aria-label': 'Remove keymap preset',
          onclick: () => {
            if (!isUser) return;
            removeUserPreset(cur.slice(5));
            this.redraw();
          },
        },
        icon('remove'),
      ),
      h('div', { class: 'hdr-spacer' }),
      h('button', { class: 'btn', 'data-tip': 'Import\nLoad a key configuration from a JSON file', onclick: () => void this.importFile() }, icon('import'), 'Import…'),
      h('button', { class: 'btn', 'data-tip': 'Export\nSave the current key configuration as a JSON file', onclick: () => this.exportFile() }, icon('export'), 'Export…'),
    );
  }

  async importFile() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      importKeyconfigText(await f.text(), f.name.replace(/\.json$/i, ''));
      app.report('INFO', `Key configuration "${f.name}" imported`);
    } catch (e) {
      app.report('ERROR', `Could not import ${f.name}: ${(e as Error).message}`);
    }
    app.changed('ui');
    this.redraw();
  }

  exportFile() {
    const name = keyconfig.data.name ?? (keyconfig.data.preset === 'DEFAULT' ? 'keymap' : keyconfig.data.preset.toLowerCase());
    download(exportKeyconfigText(name), `${name.replace(/[^\w.-]+/g, '_')}.json`, 'application/json');
  }

  private optionsPanel(): Child {
    const o = keyconfig.data.options;
    const set = (patch: Partial<typeof o>) => {
      keyconfig.data.options = { ...o, ...patch };
      keyconfig.apply();
      this.changed();
    };
    return panel('pf-km-options', 'Preferences', () => [
      splitRow(
        'Spacebar Action',
        enumRow(
          'km-space',
          [
            { value: 'PLAY', label: 'Play', description: 'Space plays the animation (Shift Space opens the tool menu)' },
            { value: 'TOOL', label: 'Tools', description: 'Space opens the tool menu (Shift Space plays)' },
            { value: 'SEARCH', label: 'Search', description: 'Space searches commands (Shift Space plays)' },
          ],
          o.spacebar_action,
          (v) => set({ spacebar_action: v as typeof o.spacebar_action }),
        ),
      ),
      splitRow('', checkbox('km-selall', 'Select All Toggles', o.use_select_all_toggle, (v) => set({ use_select_all_toggle: v }), { tip: 'Select All Toggles\nA deselects everything when something is already selected' }), undefined, 'check'),
      splitRow('', checkbox('km-tabpie', 'Tab for Pie Menu', o.use_v3d_tab_menu, (v) => set({ use_v3d_tab_menu: v }), { tip: 'Tab for Pie Menu\nTab opens the mode pie menu; Ctrl Tab toggles Edit Mode' }), undefined, 'check'),
      splitRow(
        'Tool Keys',
        enumRow(
          'km-toolkeys',
          [
            { value: 'IMMEDIATE', label: 'Immediate', description: 'G, R and S move, rotate and scale right away' },
            { value: 'TOOL', label: 'Active Tool', description: 'G, R and S switch to the Move, Rotate and Scale tools' },
          ],
          o.use_key_activate_tools ? 'TOOL' : 'IMMEDIATE',
          (v) => set({ use_key_activate_tools: v === 'TOOL' }),
        ),
      ),
    ], { closed: true });
  }

  // ------------------------------------------------------------------ search

  private searchBar(): Child {
    const n = keyconfig.modifiedCount();
    return h(
      'div',
      { class: 'km-toolbar' },
      h(
        'div',
        { class: 'enum-row km-mode' },
        h('button', { class: { on: this.searchMode === 'NAME' }, onclick: () => ((this.searchMode = 'NAME'), (this.exactKey = false), this.redraw()) }, 'Name'),
        h('button', { class: { on: this.searchMode === 'KEY' }, onclick: () => ((this.searchMode = 'KEY'), this.redraw()) }, 'Key-Binding'),
      ),
      h(
        'label',
        { class: 'text-field km-search' },
        icon('search'),
        h('input', {
          value: this.recording ? 'Press a key…' : this.search,
          placeholder: this.searchMode === 'NAME' ? 'Search by name or operator' : 'Search by key, e.g. ctrl z',
          spellcheck: 'false',
          readonly: this.recording,
          'aria-label': 'Search keymap',
          oninput: (e: Event) => ((this.search = (e.target as HTMLInputElement).value), (this.exactKey = false), this.redraw()),
          onkeydown: (e: KeyboardEvent) => {
            if (!this.recording) return;
            e.preventDefault();
            e.stopPropagation();
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
            this.recording = false;
            if (e.key !== 'Escape') {
              this.search = bindingLabel({ key: keyName(e), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey });
              this.exactKey = true;
            }
            // a focused input keeps its text through redraws: set it directly
            (e.target as HTMLInputElement).value = this.search;
            this.redraw();
          },
          onblur: () => {
            if (this.recording) {
              this.recording = false;
              this.redraw();
            }
          },
        }),
        this.search ? h('button', { class: 'km-clear', 'aria-label': 'Clear search', onclick: () => ((this.search = ''), (this.exactKey = false), this.redraw()) }, icon('x')) : null,
      ),
      this.searchMode === 'KEY'
        ? h(
            'button',
            {
              class: { 'btn icon-btn km-record': true, on: this.recording },
              'data-tip': 'Search by Key Press\nPress a key combination to find what it does',
              'aria-label': 'Search by key press',
              onclick: (e: MouseEvent) => {
                this.recording = true;
                this.redraw();
                const input = (e.currentTarget as HTMLElement).parentElement?.querySelector('.km-search input') as HTMLInputElement | null;
                if (input) {
                  input.focus();
                  input.value = 'Press a key…';
                }
              },
            },
            icon('keyboard'),
          )
        : null,
      h('button', { class: 'btn', disabled: !n, 'data-tip': 'Restore All\nUndo every change to the key bindings of this preset', onclick: () => (keyconfig.restoreAll(), app.report('INFO', 'Key bindings restored'), this.changed()) }, 'Restore All'),
    );
  }

  private matches(k: KeyItem): boolean {
    if (keyconfig.isRemoved(k)) return false;
    const q = this.search.trim().toLowerCase();
    if (!q) return true;
    if (this.searchMode === 'KEY') return matchKeyQuery(k, this.exactKey ? this.search.replace(/\(.*\)$/, '') : q, this.exactKey);
    const op = (k.op ?? '').toLowerCase();
    return itemLabel(k).toLowerCase().includes(q) || op.includes(q) || op.replace(/[._]/g, ' ').includes(q);
  }

  // ------------------------------------------------------------------ tree

  private tree(): Child {
    const names = Object.keys(keymaps).filter((n) => keymaps[n].length || Object.values(PARENT).includes(n));
    const children = new Map<string, string[]>();
    const tops: string[] = [];
    for (const n of names) {
      const p = PARENT[n];
      if (p) (children.get(p) ?? children.set(p, []).get(p)!).push(n);
      else tops.push(n);
    }
    for (const p of children.keys()) if (!tops.includes(p)) tops.push(p);
    const rank = (n: string) => (TOP_ORDER.indexOf(n) < 0 ? TOP_ORDER.length : TOP_ORDER.indexOf(n));
    tops.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const searching = !!this.search.trim();
    const node = (name: string, sub: boolean): Child => {
      const items = (keymaps[name] ?? []).filter((k) => this.matches(k));
      const kids = (children.get(name) ?? []).map((c) => node(c, true)).filter(Boolean);
      if (searching && !items.length && !kids.length) return null;
      const mod = keyconfig.modifiedCount(name) > 0;
      return panel(
        `pf-km-${name}`,
        name,
        () => [
          items.length ? h('div', { class: 'km-list' }, items.map((k) => this.itemRow(name, k))) : null,
          searching ? null : h(
            'div',
            { class: 'km-actions' },
            h('button', { class: 'btn', 'data-tip': `Add New\nAdd a key binding to ${name}`, onclick: () => this.addNew(name) }, icon('add'), 'Add New'),
            mod ? h('button', { class: 'btn', 'data-tip': `Restore\nRestore the default bindings of ${name}`, onclick: () => (keyconfig.restoreKeymap(name), this.changed()) }, icon('km_restore'), 'Restore') : null,
          ),
          kids,
        ],
        { closed: !searching, sub, className: mod ? 'km-modified' : '' },
      );
    };
    return h('div', { class: 'km-tree' }, tops.map((t) => node(t, false)));
  }

  private addNew(km: string) {
    const k = keyconfig.addItem(km, { key: 'NONE', op: '' });
    this.expanded.add(keyconfig.idOf(k));
    this.changed();
  }

  /** Other active items of the same keymap that the same key event would also trigger. */
  private conflicts(km: string, k: KeyItem): KeyItem[] {
    if (k.inactive || k.key === 'NONE') return [];
    const sig = (x: KeyItem) => `${x.key}|${!!x.ctrl}|${!!x.shift}|${!!x.alt}|${!!x.any}|${x.value ?? 'PRESS'}`;
    const s = sig(k);
    // items with different context predicates may share keys on purpose
    return (keymaps[km] ?? []).filter((x) => x !== k && !x.inactive && x.when === k.when && sig(x) === s);
  }

  private itemRow(km: string, k: KeyItem): Child {
    const active = !k.inactive;
    const capturing = this.capturing === k;
    const modified = keyconfig.isModified(k);
    const id = keyconfig.idOf(k) || `${km}-${keymaps[km].indexOf(k)}`;
    const open = this.expanded.has(id);
    const clash = this.conflicts(km, k);
    return h(
      'div',
      { key: id, class: { 'km-item': true, open } },
      h(
        'div',
        { class: { 'km-row': true, inactive: !active, modified } },
        h('button', { class: 'km-expand', 'aria-label': open ? 'Collapse' : 'Expand', 'aria-expanded': open ? 'true' : 'false', onclick: () => (open ? this.expanded.delete(id) : this.expanded.add(id), this.redraw()) }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
        checkbox(`km-a-${id}`, '', active, (v) => this.edit(k, { active: v }), { tip: 'Active\nTurn this key binding on or off' }),
        h(
          'span',
          { class: 'km-name', title: k.op ? `${k.op}${k.props ? ' ' + JSON.stringify(k.props) : ''}` : '' },
          clash.length ? h('span', { class: 'km-clash', 'data-tip': `Conflict\nThe same key also runs: ${clash.map(itemLabel).join(', ')}. The item listed first wins.` }, icon('error')) : null,
          itemLabel(k),
        ),
        h('input', {
          class: { 'km-key': true, capturing },
          readonly: true,
          'data-capture': 'key',
          value: capturing ? 'Press a key…' : bindingLabel(k),
          'aria-label': `Key for ${itemLabel(k)}`,
          'data-tip': 'Key Binding\nClick, then press the new key combination (Esc cancels)',
          onfocus: (e: FocusEvent) => {
            this.capturing = k;
            this.redraw();
            (e.target as HTMLInputElement).value = 'Press a key…';
          },
          onblur: () => {
            if (this.capturing === k) {
              this.capturing = null;
              this.redraw();
            }
          },
          onkeydown: (e: KeyboardEvent) => this.capture(k, e),
        }),
        modified
          ? h('button', { class: 'hdr-toggle km-reset', 'data-tip': keyconfig.isUserItem(k) ? 'Remove\nDelete this user binding' : 'Restore\nRestore this key binding to its default', 'aria-label': keyconfig.isUserItem(k) ? 'Remove binding' : 'Restore default', onclick: () => (keyconfig.isUserItem(k) ? keyconfig.remove(k) : keyconfig.restore(k), this.changed()) }, icon(keyconfig.isUserItem(k) ? 'x' : 'km_restore'))
          : h('button', { class: 'hdr-toggle km-reset', 'data-tip': 'Remove\nRemove this key binding (Restore brings it back)', 'aria-label': 'Remove binding', onclick: () => (keyconfig.remove(k), this.changed()) }, icon('x')),
      ),
      open ? this.details(km, k, id) : null,
    );
  }

  private capture(k: KeyItem, e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const input = e.target as HTMLInputElement;
    if (e.key === 'Escape') {
      this.capturing = null;
      input.blur();
      return;
    }
    this.capturing = null;
    input.blur();
    this.edit(k, { key: keyName(e), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, any: false, active: true });
  }

  private details(km: string, k: KeyItem, id: string): Child {
    const op = k.op ? operators.get(k.op) : undefined;
    const props = k.props ?? {};
    const factoryMenu = keyconfig.factoryMenuTitle(k);
    return h(
      'div',
      { class: 'km-details' },
      splitRow('Event', h('div', { class: 'km-event' },
        h('button', { class: 'enum-menu km-keypick', 'data-tip': 'Key\nPick the key from a list', onclick: (e: MouseEvent) => this.pickKey(k, e) }, h('span', { class: 'em-label' }, k.key === 'NONE' ? 'None' : keyLabel({ key: k.key, op: '' })), h('span', { class: 'em-arrow' }, icon('down_arrow_hlt'))),
        enumMenu(`km-v-${id}`, VALUES, k.value ?? 'PRESS', (v) => this.edit(k, { value: v as KeyValue }), { className: 'km-value' }),
      )),
      splitRow('Modifiers', h('div', { class: 'enum-row km-modrow' },
        h('button', { class: { on: !!k.any }, 'data-tip': 'Any\nMatch regardless of modifier keys', onclick: () => this.edit(k, { any: !k.any }) }, 'Any'),
        (['ctrl', 'shift', 'alt'] as const).map((m) => h('button', { key: m, class: { on: !!k[m] }, disabled: !!k.any, 'aria-pressed': k[m] ? 'true' : 'false', onclick: () => this.edit(k, { [m]: !k[m] } as Edit) }, m === 'ctrl' ? 'Ctrl' : m === 'shift' ? 'Shift' : 'Alt')),
      )),
      splitRow('', checkbox(`km-rep-${id}`, 'Repeat', k.repeat !== false, (v) => this.edit(k, { repeat: v }), { tip: 'Repeat\nRun again while the key is held down (keyboard auto-repeat)' }), undefined, 'check'),
      splitRow('Operator', h('div', { class: 'km-opfield' },
        h('button', { class: 'enum-menu km-oppick', 'data-tip': 'Operator\nChoose what the key runs', onclick: (e: MouseEvent) => this.pickOperator(k, e) },
          h('span', { class: 'em-label' }, k.op ? `${op?.label ?? '?'}  ·  ${k.op}` : factoryMenu && k.menuTitle ? `${k.menuTitle} Menu (built in)` : k.action ? 'Built-in action' : 'Choose…'),
          h('span', { class: 'em-arrow' }, icon('search')),
        ),
      )),
      k.op && !op ? h('div', { class: 'prefs-note err' }, `Unknown operator "${k.op}": this binding does nothing.`) : null,
      op?.props?.length
        ? h('div', { class: 'km-props' }, op.props.map((d) => {
            const v = d.id in props ? props[d.id] : d.default;
            return h('div', { key: d.id, class: { 'km-prop': true, set: d.id in props } }, propEditor(`km-p-${id}-${d.id}`, d, v, (nv) => this.setProp(k, d, nv)));
          }))
        : null,
      !op && k.op && Object.keys(props).length ? h('div', { class: 'prefs-note' }, `Properties: ${JSON.stringify(props)}`) : null,
      h('div', { class: 'km-actions' },
        h('button', { class: 'btn', 'data-tip': 'Remove\nRemove this key binding', onclick: () => (this.expanded.delete(id), keyconfig.remove(k), this.changed()) }, icon('remove'), 'Remove'),
        !keyconfig.isUserItem(k) ? h('button', { class: 'btn', disabled: !keyconfig.isModified(k), onclick: () => (keyconfig.restore(k), this.changed()) }, icon('km_restore'), 'Restore') : null,
      ),
    );
  }

  private setProp(k: KeyItem, d: PropDef, v: unknown) {
    const props = { ...(k.props ?? {}) };
    if (JSON.stringify(v) === JSON.stringify(d.default)) delete props[d.id];
    else props[d.id] = v;
    this.edit(k, { props });
  }

  private pickKey(k: KeyItem, e: MouseEvent) {
    openSearch(
      () => KEY_NAMES.map((n) => ({ label: n === 'NONE' ? 'None' : keyLabel({ key: n, op: '' }), path: n, run: () => this.edit(k, { key: n }) })),
      e.clientX - 40,
      e.clientY,
      'Search keys…',
    );
  }

  private pickOperator(k: KeyItem, e: MouseEvent) {
    const entries = () =>
      [...operators.values()]
        .filter((o) => !o.idname.startsWith('__'))
        .map((o) => ({ label: o.label, path: o.idname, run: () => this.edit(k, { op: o.idname, props: {} } as Partial<ItemFields>) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    openSearch(entries, e.clientX - 80, e.clientY, 'Search operators by name or id…');
  }
}

/** Menu of Preferences ▸ Keymap actions (for the preset menu button and F3). */
export function keymapPresetMenu(view: KeymapView) {
  openMenu(
    [
      ...presetChoices().map((c) => ({ label: c.label, active: c.value === currentPresetChoice(), action: () => (choosePreset(c.value), app.changed('ui')) })),
      { separator: true },
      { label: 'Import…', icon: 'import', action: () => void view.importFile() },
      { label: 'Export…', icon: 'export', action: () => view.exportFile() },
      Object.keys(userPresets()).length ? { separator: true } : null,
    ].filter(Boolean) as never,
    { x: app.pointer.x, y: app.pointer.y },
  );
}
