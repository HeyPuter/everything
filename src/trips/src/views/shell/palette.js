import { el, uid } from '../../ui/dom.js';
import { field } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { t } from '../../lib/i18n/index.js';

export function shortcutLabel(command, mac) {
  const modifier = t(mac ? 'app.modMac' : 'app.modOther');
  const key = { palette: 'app.shortcutPalette', appearance: 'app.shortcutSettings', home: 'app.shortcutHome', help: 'app.shortcutHelpKey' }[command.id];
  return key ? t(key, { modifier }) : t('app.shortcutCustom', { keys: command.shortcut?.replace('Mod', modifier) ?? '' });
}
export function openCommandPalette({ registry, onRun, mac, onClose }) {
  const listId = uid('commands');
  const search = field({ label: t('app.commandSearch'), type: 'search', prefix: 'search', autocomplete: 'off' });
  const list = el('div.command-list', { id: listId, role: 'listbox', 'aria-label': t('app.commands') });
  const empty = el('p.command-empty', { role: 'status', hidden: true }, t('app.noCommands'));
  let matches = [];
  let selected = 0;
  let dialog;
  function choose(index) {
    if (!matches.length) return;
    selected = (index + matches.length) % matches.length;
    [...list.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)));
    search.input.setAttribute('aria-activedescendant', list.children[selected].id);
    list.children[selected].scrollIntoView?.({ block: 'nearest' });
  }
  function run() { const command = matches[selected]; if (command) { dialog.close('command'); onRun(command); } }
  function render() {
    const query = search.input.value.trim().toLocaleLowerCase();
    matches = registry.list().filter((command) => !command.hidden && t(command.labelKey).toLocaleLowerCase().includes(query));
    list.replaceChildren(...matches.map((command, index) => el('button.command-item', {
      id: `${listId}-${command.id}`, type: 'button', role: 'option', tabIndex: -1, 'aria-selected': index === 0,
      onmousedown: (event) => event.preventDefault(), onclick: () => { selected = index; run(); },
    }, el('span', {}, t(command.labelKey)), command.shortcut && el('kbd', {}, shortcutLabel(command, mac)))));
    selected = 0; empty.hidden = matches.length > 0;
    search.input.removeAttribute('aria-activedescendant'); if (matches.length) choose(0);
  }
  search.input.setAttribute('role', 'combobox'); search.input.setAttribute('aria-autocomplete', 'list');
  search.input.setAttribute('aria-controls', listId); search.input.setAttribute('aria-expanded', 'true');
  search.input.addEventListener('input', render);
  search.input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); choose(selected + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter' && matches.length) { event.preventDefault(); run(); }
  });
  render();
  dialog = openModal({ title: t('app.commandPalette'), content: el('div', {}, search.element, list, empty), initialFocus: search.input, onClose });
  return dialog;
}
export function openShortcutHelp({ registry, mac, onClose }) {
  return openModal({ title: t('app.shortcuts'), onClose, content: el('div.shortcut-help', {},
    el('p', {}, t('app.shortcutHelp')),
    el('dl.shortcut-list', {}, registry.list().filter((command) => command.shortcut).flatMap((command) => [
      el('dt', {}, t(command.labelKey)), el('dd', {}, el('kbd', {}, shortcutLabel(command, mac))),
    ])),
  ) });
}
