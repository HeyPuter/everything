/**
 * Options (per-user preferences) and keyboard shortcut customization.
 */
import { h, clear, MOD } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast } from './dialog.js';
import { COMMANDS, applyShortcuts } from '../commands.js';
import { RIBBON } from './ribbon-def.js';
import { setTooltipMode } from './tooltip.js';

/** Ribbon tab of each command, to group and search shortcuts. */
function commandTabs() {
  const out = new Map();
  const walk = (items, tab) => {
    for (const it of items || []) {
      if (it.cmd && !out.has(it.cmd)) out.set(it.cmd, tab);
      for (const v of it.variants || []) if (v.cmd && !out.has(v.cmd)) out.set(v.cmd, tab);
      if (it.items) walk(it.items, tab);
    }
  };
  for (const t of RIBBON) for (const p of t.panels || []) walk(p.items, t.label);
  return out;
}

export function shortcutsDialog(app) {
  const overrides = { ...(app.settings.shortcuts || {}) };
  const tabs = commandTabs();
  const names = Object.keys(COMMANDS).filter((n) => COMMANDS[n].run && COMMANDS[n].label && !/^[a-z]+-/.test(n));
  const keysOf = (n) => (n in overrides ? overrides[n] : COMMANDS[n].defaultKeys ?? COMMANDS[n].keys ?? '');
  const search = h('input.input', { type: 'search', placeholder: 'Search commands or keys', 'aria-label': 'Search commands' });
  const onlyAssigned = h('input', { type: 'checkbox' });
  const tbody = h('tbody');
  const status = h('p.field-hint', { role: 'status' });
  const render = () => {
    clear(tbody);
    const q = search.value.trim().toLowerCase();
    const used = new Map();
    for (const n of names) {
      const k = keysOf(n);
      if (k) used.set(k, [...(used.get(k) || []), n]);
    }
    for (const n of names.sort((a, b) => (tabs.get(a) || 'zz').localeCompare(tabs.get(b) || 'zz') || COMMANDS[a].label.localeCompare(COMMANDS[b].label))) {
      const d = COMMANDS[n];
      const k = keysOf(n);
      if (onlyAssigned.checked && !k) continue;
      if (q && !`${d.label} ${tabs.get(n) || ''} ${k} ${d.accel || ''}`.toLowerCase().includes(q)) continue;
      const clash = k && used.get(k).length > 1;
      const input = h('input.input.sm.kbd-input', { type: 'text', value: k, maxLength: 2, 'aria-label': `Shortcut for ${d.label}`, 'aria-invalid': clash ? 'true' : null, placeholder: '--' });
      input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '')));
      input.addEventListener('change', () => {
        const v = input.value;
        if (v && v.length !== 2) {
          input.value = k;
          status.textContent = 'Shortcuts are two letters.';
          return;
        }
        if (v === (d.defaultKeys ?? d.keys ?? '')) delete overrides[n];
        else overrides[n] = v;
        render();
      });
      const reset = h('button.icon-btn.sm', { type: 'button', 'aria-label': `Reset ${d.label}`, 'data-tip': 'Restore the default', disabled: !(n in overrides), onClick: () => (delete overrides[n], render()) }, icon('undo', 14));
      tbody.append(
        h('tr', { class: clash ? 'kbd-clash' : null },
          h('td', h('span.inline', icon(d.icon || 'keyboard', 14), d.label)),
          h('td.muted', tabs.get(n) || ''),
          h('td', input),
          h('td', d.accel ? h('kbd', d.accel.replace('Ctrl', MOD)) : ''),
          h('td', reset)),
      );
    }
    const clashes = [...used].filter(([, list]) => list.length > 1);
    const describeClash = ([k, list]) => `${k}: ${list.map((n) => COMMANDS[n].label).join(', ')}`;
    status.textContent = clashes.length ? `Shared shortcuts (typing one runs the first command): ${clashes.slice(0, 3).map(describeClash).join('; ')}${clashes.length > 3 ? `; and ${clashes.length - 3} more` : ''}.` : 'Type two letters in a view to run a command. Enter repeats the last tool, Esc cancels, Tab cycles overlapping elements.';
  };
  search.addEventListener('input', render);
  onlyAssigned.addEventListener('change', render);
  render();
  const exportKeys = () => {
    const data = JSON.stringify({ format: 'building-design-shortcuts', shortcuts: Object.fromEntries(names.map((n) => [n, keysOf(n)]).filter(([, k]) => k)) }, null, 2);
    const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'shortcuts.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importKeys = () => {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        if (data?.format !== 'building-design-shortcuts') throw new Error('not a shortcuts file');
        for (const n of names) {
          const v = data.shortcuts?.[n] ?? '';
          if (v === (COMMANDS[n].defaultKeys ?? COMMANDS[n].keys ?? '')) delete overrides[n];
          else overrides[n] = /^[A-Z]{2}$/.test(v) ? v : '';
        }
        render();
      } catch {
        toast('That file is not a shortcuts file exported from this app.', { kind: 'error' });
      }
    });
    input.click();
  };
  return openDialog({
    title: 'Keyboard Shortcuts',
    size: 'lg',
    body: h(
      'div.kbd-editor',
      h('div.kbd-tools', search, h('label.check', onlyAssigned, 'Only commands with shortcuts'), h('span.grow'), h('button.btn.sm', { type: 'button', onClick: importKeys }, 'Import...'), h('button.btn.sm', { type: 'button', onClick: exportKeys }, 'Export...'), h('button.btn.sm', { type: 'button', onClick: () => (Object.keys(overrides).forEach((k) => delete overrides[k]), render()) }, 'Reset all')),
      h('div.kbd-scroll', h('table.vg-table', h('thead', h('tr', h('th', 'Command'), h('th', 'Tab'), h('th', 'Keys'), h('th', 'Also'), h('th', h('span.sr-only', 'Reset')))), tbody)),
      status,
    ),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        onClick: () => {
          app.settingsStore.set('shortcuts', overrides);
          applyShortcuts(overrides);
          app.ribbon.renderBody();
          return true;
        },
      },
    ],
  });
}

/** Per-user preferences, grouped in tabs. */
export function optionsDialog(app) {
  const s = app.settings;
  const next = {};
  const val = (k) => (k in next ? next[k] : s[k]);
  const set = (k, v) => (next[k] = v);
  const check = (k, label, hint) =>
    h('label.check.opt-row', h('input', { type: 'checkbox', checked: !!val(k), onChange: (e) => set(k, e.target.checked) }), h('span', label, hint ? h('small.field-hint', hint) : null));
  const select = (k, label, options) => {
    const sel = h('select.input', { onChange: (e) => set(k, e.target.value) }, options.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = val(k) ?? options[0][0];
    return h('label.field.opt-row', h('span.field-label', label), sel);
  };
  const sections = {
    General: () => [
      select('units', 'Units of new projects', [
        ['', 'Ask each time'],
        ['metric', 'Metric (millimetres)'],
        ['imperial', 'Imperial (feet and inches)'],
      ]),
      check('autoSync', 'Live updates in shared projects', 'Changes others save appear while you work.'),
    ],
    Interface: () => [
      select('theme', 'Theme', [
        ['system', 'Same as the system'],
        ['light', 'Light'],
        ['dark', 'Dark'],
      ]),
      select('tooltips', 'Tooltips', [
        ['full', 'Names, shortcuts and descriptions'],
        ['short', 'Names and shortcuts only'],
        ['off', 'Off'],
      ]),
      h('button.btn', { type: 'button', onClick: () => app.run('shortcuts') }, icon('keyboard', 16), 'Keyboard shortcuts...'),
    ],
    Graphics: () => [check('thinLines', 'Thin lines', 'Draw every line one pixel wide, whatever its weight.'), check('snapLabels', 'Snap labels', 'Name the snap (Endpoint, Midpoint...) next to the cursor.')],
    Navigation: () => [check('wheelZoomOnly', 'The mouse wheel only zooms', 'Turn off two-finger trackpad panning.')],
    Selection: () => [
      check('selectPinned', 'Select pinned elements'),
      check('dragOnSelect', 'Drag elements when selecting', 'Off: the first click selects, the next drag moves.'),
      h('button.btn', { type: 'button', onClick: () => app.run('snaps') }, icon('magnet', 16), 'Snaps...'),
    ],
  };
  const nav = h('div.opt-nav', { role: 'tablist', 'aria-orientation': 'vertical' });
  const panel = h('div.opt-panel', { role: 'tabpanel' });
  const show = (name) => {
    for (const b of nav.children) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    clear(panel);
    panel.append(h('h3.dlg-sub', name), ...sections[name]());
  };
  for (const name of Object.keys(sections)) nav.append(h('button.opt-tab', { type: 'button', role: 'tab', dataset: { tab: name }, onClick: () => show(name) }, name));
  show('General');
  return openDialog({
    title: 'Options',
    size: 'md',
    body: h('div.opt-layout', nav, panel),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        onClick: () => {
          for (const [k, v] of Object.entries(next)) {
            if (k === 'theme') app.setTheme(v);
            else app.settingsStore.set(k, k === 'units' ? v || null : v);
          }
          setTooltipMode(app.settings.tooltips);
          if ('thinLines' in next) app.requestRender();
          app.ribbon.refresh();
          return true;
        },
      },
    ],
  });
}
