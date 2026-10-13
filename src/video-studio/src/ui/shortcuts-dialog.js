/**
 * Keyboard shortcuts dialog: pick a keyboard layout, browse every command
 * by group, search, and rebind keys. Rebinding records the next key
 * combination pressed; a key another command uses can be taken over after
 * confirming. Switching layouts asks whether the user's own rebinding stays
 * on top; keys two commands share are listed (and get their own tab).
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isMac, shortcutLabel } from '../lib/platform.js';
import { SHORTCUT_GROUPS, RESERVED_KEYS } from './commands.js';
import { openDialog, confirmDialog } from './dialog.js';
import { segmented } from './controls.js';

const CODE_NAMES = {
  Space: 'Space', Period: 'Period', Slash: 'Slash', Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Comma: 'Comma',
  Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Backquote', Backslash: 'Backslash',
};
const KEY_NAMES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace', 'Escape', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Tab',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);

/**
 * Shortcut spec ("Mod+Shift+K") for a keydown, or null for a lone modifier
 * or a key the editor can't match.
 */
export function specFromEvent(e) {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return null;
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_NAMES[e.code]) key = CODE_NAMES[e.code];
  else if (KEY_NAMES.has(e.key)) key = e.key;
  if (!key) return null;
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * Ask what happens to the user's rebinding when switching layouts:
 * 'keep' (on top of the new layout), 'discard', or null (cancel).
 */
export function askKeepCustom(count, layoutLabel) {
  const keep = h('button.btn.primary', { type: 'button' }, 'Keep mine on top');
  const discard = h('button.btn', { type: 'button' }, 'Use the layout only');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const d = openDialog({
    title: `Switch to ${layoutLabel}?`,
    body: h('p.dialog-text', `You changed ${count} shortcut${count === 1 ? '' : 's'}. Keep ${count === 1 ? 'it' : 'them'} on top of the ${layoutLabel} layout, or use the layout as it is?`),
    actions: [cancel, h('span.spacer'), discard, keep],
    labelledBody: true,
    className: 'small',
  });
  keep.addEventListener('click', () => d.close('keep'));
  discard.addEventListener('click', () => d.close('discard'));
  cancel.addEventListener('click', () => d.close(null));
  keep.focus();
  return d.result.then((v) => (v === 'keep' || v === 'discard' ? v : null));
}

export function openShortcutsDialog(commands) {
  let group = 'All';
  let query = '';
  let recording = null; // { id, chip, onKey }
  const search = h('input.input.shortcut-search', { type: 'search', placeholder: 'Search commands or keys', 'aria-label': 'Search shortcuts' });
  const baseGroups = ['All', ...SHORTCUT_GROUPS.filter((g) => commands.list.some((c) => c.group === g))];
  const tabList = h('div.shortcut-tabs', { role: 'tablist', 'aria-label': 'Shortcut groups' });
  const list = h('div.shortcut-list', { role: 'region', 'aria-live': 'polite' });
  const status = h('p.shortcut-status', { role: 'status' });
  const conflictBox = h('div.shortcut-conflicts', { role: 'status' });

  // ---- Layout -------------------------------------------------------------
  const layoutDesc = h('p.shortcut-layout-desc');
  const layoutSeg = segmented({
    label: 'Keyboard layout',
    options: commands.layouts.map((l) => ({ value: l.id, label: l.label })),
    value: commands.layout,
    onChange: async (id) => {
      const layout = commands.layouts.find((l) => l.id === id);
      const n = commands.customCount();
      let keepCustom = true;
      if (n) {
        const answer = await askKeepCustom(n, layout.label);
        if (!answer) {
          layoutSeg.set(commands.layout);
          return;
        }
        keepCustom = answer === 'keep';
      }
      commands.setLayout(id, { keepCustom });
      const clashes = commands.allConflicts().length;
      status.textContent = `${layout.label} layout${clashes ? `. ${clashes} key${clashes === 1 ? ' is' : 's are'} shared by two commands.` : ''}`;
      announce(status.textContent);
      renderAll();
    },
  });
  const renderLayout = () => {
    layoutSeg.set(commands.layout);
    layoutDesc.textContent = commands.layouts.find((l) => l.id === commands.layout)?.description || '';
  };
  const layoutRow = h('div.shortcut-layout', h('span.field-label', 'Layout'), layoutSeg.el, layoutDesc);

  // ---- Conflicts ----------------------------------------------------------
  let conflictIds = new Set();
  const renderConflicts = () => {
    const clashes = commands.allConflicts();
    conflictIds = new Set(clashes.flatMap((x) => x.commands.map((c) => c.id)));
    conflictBox.hidden = !clashes.length;
    if (!clashes.length) {
      conflictBox.replaceChildren();
      if (group === 'Conflicts') group = 'All';
      return;
    }
    conflictBox.replaceChildren(
      h('p.shortcut-conflicts-title', icon('warning', 14), h('span', `${clashes.length} shortcut${clashes.length === 1 ? ' is' : 's are'} used by more than one command. The first one listed runs.`)),
      h('ul', clashes.map((x) => h('li', h('kbd.kbd-chip.static', shortcutLabel(x.key)), h('span', x.commands.map((c) => c.label).join(', '))))),
    );
  };

  const renderTabs = () => {
    const groupNames = conflictIds.size ? [...baseGroups, 'Conflicts'] : baseGroups;
    tabList.replaceChildren(...groupNames.map((g) => {
      const b = h(`button.shortcut-tab${g === 'Conflicts' ? '.is-warning' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(g === group) }, g);
      b.addEventListener('click', () => {
        group = g;
        renderTabs();
        renderList();
      });
      return b;
    }));
  };

  const stopRecording = () => {
    if (!recording) return;
    document.removeEventListener('keydown', recording.onKey, true);
    recording.chip.classList.remove('recording');
    recording = null;
  };

  const record = (cmd, chip, index) => {
    stopRecording();
    chip.classList.add('recording');
    chip.textContent = 'Press keys...';
    status.textContent = `Press the new shortcut for "${cmd.label}". Escape cancels.`;
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        stopRecording();
        status.textContent = '';
        renderList();
        return;
      }
      const spec = specFromEvent(e);
      if (!spec) return;
      stopRecording();
      if (RESERVED_KEYS.includes(spec)) {
        status.textContent = `${shortcutLabel(spec)} is reserved by the browser or the editor.`;
        renderList();
        return;
      }
      const clash = commands.conflicts(spec, cmd.id);
      if (clash.length) {
        const ok = await confirmDialog({ title: 'Shortcut in use', message: `${shortcutLabel(spec)} is used by "${clash.map((c) => c.label).join('", "')}". Use it for "${cmd.label}" instead?`, confirm: 'Reassign' });
        if (!ok) {
          renderList();
          return;
        }
        for (const c of clash) commands.setKeys(c.id, c.keys.filter((k) => k !== spec));
      }
      const keys = [...cmd.keys];
      if (index < keys.length) keys[index] = spec;
      else keys.push(spec);
      commands.setKeys(cmd.id, [...new Set(keys)]);
      status.textContent = `${cmd.label}: ${shortcutLabel(spec)}`;
      announce(status.textContent);
      renderAll();
    };
    recording = { id: cmd.id, chip, onKey };
    document.addEventListener('keydown', onKey, true);
  };

  const row = (cmd) => {
    const chips = cmd.keys.map((k, i) => {
      const chip = h('button.kbd-chip', { type: 'button', 'aria-label': `Change shortcut ${shortcutLabel(k)} for ${cmd.label}` }, shortcutLabel(k));
      chip.addEventListener('click', () => record(cmd, chip, i));
      const remove = h('button.icon-btn.small.kbd-remove', { type: 'button', 'aria-label': `Remove ${shortcutLabel(k)} from ${cmd.label}`, 'data-tip': 'Remove' }, icon('close', 12));
      remove.addEventListener('click', () => {
        commands.setKeys(cmd.id, cmd.keys.filter((x) => x !== k));
        renderAll();
      });
      return h('span.kbd-pair', chip, remove);
    });
    const add = h('button.kbd-chip.add', { type: 'button', 'aria-label': `Add a shortcut for ${cmd.label}` }, cmd.keys.length ? '+' : 'Add shortcut');
    add.addEventListener('click', () => record(cmd, add, cmd.keys.length));
    const reset = commands.isCustom(cmd.id) ? h('button.btn.ghost.small', { type: 'button', 'aria-label': `Reset ${cmd.label} to its default`, 'data-tip': 'Default: ' + (cmd.defaultKeys.map(shortcutLabel).join(', ') || 'none') }, icon('reset', 14)) : null;
    reset?.addEventListener('click', () => {
      commands.setKeys(cmd.id, null);
      renderAll();
    });
    const clash = conflictIds.has(cmd.id) ? h('span.shortcut-clash', { 'data-tip': 'Shares a key with another command' }, icon('warning', 12), 'Conflict') : null;
    return h(`div.shortcut-row${clash ? '.has-conflict' : ''}`, h('span.shortcut-label', cmd.label, commands.isCustom(cmd.id) ? h('span.shortcut-custom', 'Custom') : null, clash), h('span.shortcut-keys', chips, add, reset));
  };

  const renderList = () => {
    const q = query.trim().toLowerCase();
    const groups = group === 'All' || group === 'Conflicts' ? SHORTCUT_GROUPS : [group];
    const sections = groups.map((g) => {
      const items = commands.list.filter((c) => c.group === g && (group !== 'Conflicts' || conflictIds.has(c.id)) && (!q || c.label.toLowerCase().includes(q) || c.keys.some((k) => shortcutLabel(k).toLowerCase().includes(q) || k.toLowerCase().includes(q))));
      if (!items.length) return null;
      return h('section.shortcut-group', h('h3', g), items.map(row));
    }).filter(Boolean);
    list.replaceChildren(...(sections.length ? sections : [h('p.empty-note', 'No commands match.')]));
  };

  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  // Every edit can add or clear a conflict, so the whole view follows.
  function renderAll() {
    renderLayout();
    renderConflicts();
    renderTabs();
    renderList();
  }
  renderAll();

  const resetAll = h('button.btn', { type: 'button' }, 'Reset to layout');
  const done = h('button.btn.primary', { type: 'button' }, 'Done');
  const d = openDialog({
    title: 'Keyboard shortcuts',
    body: h('div.shortcuts-editor', layoutRow, h('div.shortcut-top', tabList, search), conflictBox, list, status),
    actions: [resetAll, h('span.spacer'), done],
    wide: true,
    className: 'shortcuts-dialog',
    onClose: stopRecording,
  });
  resetAll.addEventListener('click', async () => {
    const layout = commands.layouts.find((l) => l.id === commands.layout);
    const ok = await confirmDialog({ title: 'Reset shortcuts?', message: `Every shortcut goes back to the ${layout.label} layout.`, confirm: 'Reset' });
    if (!ok) return;
    commands.resetKeys();
    renderAll();
  });
  done.addEventListener('click', () => d.close());
  return d;
}
