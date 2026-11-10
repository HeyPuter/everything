import { el } from './dom.js';
import { openModal } from './modal.js';

/**
 * The keyboard, written down.
 *
 * Five shortcuts already worked before this file existed, and nothing in the
 * app said so -- which is most of the reason nobody used them. The sheet below
 * is the answer to `?`, and it is built from the same constants app.js
 * dispatches on, so a chord that stops working stops being printed too.
 */

/**
 * Ctrl on most platforms, the command key on a Mac. Only for the labels a
 * shortcut is printed with -- what a binding actually listens for is
 * `metaKey || ctrlKey`, so the key that works is the one the platform has.
 */
export const MOD = /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform
  || globalThis.navigator?.userAgent || '') ? '\u2318' : 'Ctrl+';

/**
 * The second key of a `g` chord, per folder. A chord is namespaced by its
 * first key, so these are free to be letters that mean something else on their
 * own: `s` stars a message and `g s` goes to Starred.
 */
export const FOLDER_KEYS = {
  inbox: 'i',
  starred: 's',
  sent: 't',
  drafts: 'd',
  archive: 'a',
  snoozed: 'z',
  // The key that deletes a message everywhere else in the app, so "go to
  // where the deleted ones are" is the same key asked a different way.
  trash: '#',
};

/**
 * `keys` are alternatives -- any one of them does it. `chord` is a sequence:
 * the keys are pressed one after another.
 */
const GROUPS = (folders) => [
  {
    heading: 'Anywhere',
    items: [
      { keys: ['c'], label: 'Write a message', needs: 'compose' },
      { keys: ['/'], label: 'Search this folder' },
      ...folders.map((folder) => ({
        chord: ['g', FOLDER_KEYS[folder.id]],
        label: `Go to ${folder.label}`,
      })),
      { keys: ['?'], label: 'This list' },
    ],
  },
  {
    heading: 'In the list',
    items: [
      { keys: ['j'], label: 'Next message' },
      { keys: ['k'], label: 'Previous message' },
      { keys: ['Enter'], label: 'Open' },
      { keys: ['x'], label: 'Select' },
      { keys: ['s'], label: 'Star' },
      { keys: ['u'], label: 'Mark read or unread' },
      { keys: ['e'], label: 'Archive' },
      { keys: ['b'], label: 'Snooze or change wake time' },
      { keys: ['#', 'Delete'], label: 'Delete' },
    ],
  },
  {
    heading: 'Writing a message',
    items: [
      { keys: [`${MOD}Enter`], label: 'Send', needs: 'compose' },
      { keys: ['Escape'], label: 'Close, keeping the draft', needs: 'compose' },
    ],
  },
  {
    heading: 'Reading a message',
    items: [
      { keys: ['j'], label: 'Older conversation' },
      { keys: ['k'], label: 'Newer conversation' },
      { keys: ['r'], label: 'Reply', needs: 'compose' },
      { keys: ['a'], label: 'Reply all', needs: 'compose' },
      { keys: ['f'], label: 'Forward', needs: 'compose' },
      { keys: ['s'], label: 'Star' },
      { keys: ['u'], label: 'Mark as unread' },
      { keys: ['e'], label: 'Archive' },
      { keys: ['b'], label: 'Snooze or change wake time' },
      { keys: ['#', 'Delete'], label: 'Delete' },
      { keys: ['Escape'], label: 'Back to the list' },
    ],
  },
];

const keyNode = (key) => el('kbd.shortcut-key', {}, key);

// "g then i" rather than "g i": the gap between two keys in a chord is the
// whole difference between it and a key with a modifier held down.
const keysNode = (item) => {
  const node = el('span.shortcut-keys');
  if (item.chord) {
    item.chord.forEach((key, index) => {
      if (index) node.append(el('span.shortcut-join', {}, 'then'));
      node.append(keyNode(key));
    });
    return node;
  }
  item.keys.forEach((key, index) => {
    if (index) node.append(el('span.shortcut-join', {}, 'or'));
    node.append(keyNode(key));
  });
  return node;
};

/**
 * openShortcuts({ folders, canCompose }) — `folders` is the sidebar's own
 * list, so the sheet names the folders this account actually has rather than
 * every folder the app can show. Where sending is absent, so is everything
 * here that would send.
 */
export function openShortcuts({ folders = [], canCompose = true } = {}) {
  const known = folders.filter((folder) => FOLDER_KEYS[folder.id]);

  const sheet = el('div.shortcuts', {},
    GROUPS(known).map(({ heading, items }) => {
      const shown = items.filter((item) => item.needs !== 'compose' || canCompose);
      if (!shown.length) return null;
      return el('section.shortcut-group', {},
        el('h3.shortcut-heading', {}, heading),
        el('ul.shortcut-list', {}, shown.map((item) => el('li.shortcut', {},
          keysNode(item),
          el('span.shortcut-label', {}, item.label),
        ))),
      );
    }),
    // The one rule that explains every time a shortcut does nothing.
    el('p.shortcuts-note', {},
      'Shortcuts are off while you are typing in a field, so a message can '
      + `contain any of these letters. The ones held with ${MOD.replace('+', '')} are the `
      + 'exception, and work while you write.'),
  );

  return openModal({ title: 'Keyboard shortcuts', content: sheet });
}
