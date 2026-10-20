import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { openShortcuts, FOLDER_KEYS } from '../src/ui/shortcuts.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/**
 * The keyboard outside the list. The five shortcuts a focused row already
 * answered are covered by the list itself; what is new here is that a key
 * works when focus is anywhere in the app, and that the reader answers the
 * ones that belong to an open message.
 */

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

let root;
let composed;

const mount = ({ canSend = true } = {}) => {
  const { fs, mailPath, objectsPath } = createSampleMailbox();
  composed = [];
  renderApp(root, {
    fs,
    mailPath,
    objectsPath,
    sample: true,
    account: { username: 'sample' },
    onCompose: canSend ? (prefill) => composed.push(prefill ?? {}) : undefined,
  });
};

/**
 * A bare keypress, from wherever the test says it happened -- and by default
 * from the body, which is where the keyboard actually is most of the time:
 * closing a message or dismissing a banner leaves focus on nothing in
 * particular, and a shortcut has to work from there or it does not work.
 */
const press = (key, target = document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

const rows = () => [...root.querySelectorAll('.row')];
const subjectOf = (row) => row?.querySelector('.row-subject')?.textContent;
const currentFolder = () => root.querySelector('.nav-item[aria-current="true"]')?.textContent ?? '';
const sheet = () => document.querySelector('.shortcuts');

const openFirstMessage = async () => {
  rows()[0].click();
  await settle(400);
};

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast, .modal-root').forEach((node) => node.remove());
});

describe('shortcuts that work anywhere in the app', () => {
  it('writes a message on c, with focus nowhere near the list', async () => {
    mount();
    await settle();
    expect(press('c').defaultPrevented).toBe(true);
    expect(composed).toHaveLength(1);
  });

  it('leaves c alone where there is nothing to send with', async () => {
    mount({ canSend: false });
    await settle();
    expect(press('c').defaultPrevented).toBe(false);
  });

  it('puts the keyboard in the search field on /', async () => {
    mount();
    await settle();
    press('/');
    expect(document.activeElement).toBe(root.querySelector('.search-input'));
  });

  it('walks the list with j and k', async () => {
    mount();
    await settle();
    const [first, second] = rows();

    press('j');
    expect(document.activeElement).toBe(first);
    press('j');
    expect(document.activeElement).toBe(second);
    press('k');
    expect(document.activeElement).toBe(first);
    // Stops at the top rather than wrapping to the bottom.
    press('k');
    expect(document.activeElement).toBe(first);
  });

  it('goes to a folder on g then its key', async () => {
    mount();
    await settle();
    expect(currentFolder()).toContain('Inbox');

    press('g');
    press(FOLDER_KEYS.archive);
    await settle();
    expect(currentFolder()).toContain('Archive');

    press('g');
    press(FOLDER_KEYS.inbox);
    await settle();
    expect(currentFolder()).toContain('Inbox');
  });

  it('does not let the second key of a chord also mean what it means alone', async () => {
    mount();
    await settle();
    // `s` on its own stars the focused row; after `g` it is Starred, and
    // nothing else. Pressed on a focused row, which answers `s` itself.
    const starred = () => root.querySelectorAll('.star-btn[aria-pressed="true"]').length;
    const before = starred();
    const row = rows()[0];
    row.focus();
    press('g', row);
    press('s', row);
    await settle();
    expect(currentFolder()).toContain('Starred');
    press('g');
    press('i');
    await settle();
    expect(starred()).toBe(before);
  });

  it('does not archive the focused row on g then e', async () => {
    mount();
    await settle();
    const count = rows().length;
    rows()[0].focus();
    press('g', rows()[0]);
    press('e', rows()[0]);
    await settle(400);
    expect(currentFolder()).toContain('Inbox');
    expect(rows()).toHaveLength(count);
  });

  it('goes to Trash on g then a shifted #, rather than deleting the open message', async () => {
    mount();
    await settle();
    const count = rows().length;
    await openFirstMessage();
    press('g');
    // A real keyboard sends a keydown for Shift before the `#` it shifts.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '#', shiftKey: true, bubbles: true, cancelable: true }));
    await settle(400);
    expect(currentFolder()).toContain('Trash');
    press('g');
    press('i');
    await settle(400);
    expect(rows()).toHaveLength(count);
  });

  it('forgets a chord whose second key names no folder', async () => {
    mount();
    await settle();
    press('g');
    // `z` is nothing; it must end the chord rather than leave it armed.
    press('z');
    press('j');
    expect(document.activeElement).toBe(rows()[0]);
    expect(currentFolder()).toContain('Inbox');
  });

  it('still answers with a tick box focused', async () => {
    mount();
    await settle();
    const check = rows()[2].querySelector('.row-check');
    check.focus();
    check.click();
    expect(document.activeElement).toBe(check);
    press('j', check);
    expect(document.activeElement).toBe(rows()[3]);
    const all = root.querySelector('.select-all');
    all.focus();
    press('c', all);
    expect(composed).toHaveLength(1);
  });

  it('opens and closes the sheet on ?', async () => {
    mount();
    await settle();
    expect(sheet()).toBeNull();
    press('?');
    expect(sheet()).not.toBeNull();
    expect(sheet().textContent).toContain('Write a message');
  });

  it('leaves every key alone while something is being typed into', async () => {
    mount();
    await settle();
    const search = root.querySelector('.search-input');
    search.focus();
    expect(press('c', search).defaultPrevented).toBe(false);
    expect(composed).toHaveLength(0);
  });

  it('leaves a key with a modifier on it to the browser', async () => {
    mount();
    await settle();
    const event = new KeyboardEvent('keydown', {
      key: 'c', metaKey: true, bubbles: true, cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(composed).toHaveLength(0);
  });

  it('says nothing while a dialog is in front of the app', async () => {
    mount();
    await settle();
    press('?');
    expect(sheet()).not.toBeNull();
    // The sheet is a dialog and answers its own keys; the app behind it must
    // not also compose a message.
    expect(press('c').defaultPrevented).toBe(false);
    expect(composed).toHaveLength(0);
  });

  it('stands down once the app has been rendered again over it', async () => {
    mount();
    await settle();
    const stale = composed;
    // Entering or leaving the sample inbox re-renders over the same root.
    mount();
    await settle();
    press('c');
    expect(stale).toHaveLength(0);
    expect(composed).toHaveLength(1);
  });
});

describe('shortcuts while a message is open', () => {
  it('replies on r and forwards on f', async () => {
    mount();
    await settle();
    await openFirstMessage();

    press('r');
    expect(composed).toHaveLength(1);
    expect(composed[0].kind).toBe('reply');

    press('f');
    expect(composed).toHaveLength(2);
    expect(composed[1].kind).toBe('forward');
  });

  it('prefixes the subject of a reply and a forward, and leaves an empty one empty', async () => {
    mount();
    await settle();
    await openFirstMessage();
    press('r');
    press('f');
    expect(composed.map((draft) => draft.subject))
      .toEqual(['Re: Thursday walkthrough', 'Fwd: Re: Thursday walkthrough']);

    // The parcel notice has no Subject header at all. Its row says
    // "(no subject)", but that is a label for the reader, not a subject for
    // the writer: an answer to it starts with an empty one to fill in.
    press('Escape');
    await settle();
    rows().find((row) => subjectOf(row) === '(no subject)').click();
    await settle(400);
    press('r');
    press('f');
    expect(composed.slice(2).map((draft) => draft.subject)).toEqual(['', '']);
  });

  it('goes back to the list on Escape from wherever the keyboard is', async () => {
    mount();
    await settle();
    await openFirstMessage();
    // A click on the text of a message, to select a line of it, leaves the
    // keyboard on the body -- which is where most Escapes are pressed from.
    document.body.focus();
    press('Escape');
    expect(root.querySelector('.app-frame').classList.contains('reading')).toBe(false);
    // The row it came from has the keyboard back.
    expect(document.activeElement).toBe(rows()[0]);
  });

  it('closes an open drawer on Escape before it closes the message', async () => {
    mount();
    await settle();
    await openFirstMessage();
    const frame = root.querySelector('.app-frame');
    frame.classList.add('nav-open');
    press('Escape');
    expect(frame.classList.contains('nav-open')).toBe(false);
    expect(frame.classList.contains('reading')).toBe(true);
    press('Escape');
    expect(frame.classList.contains('reading')).toBe(false);
  });

  it('leaves Escape to a dialog or a menu that is open over the message', async () => {
    mount();
    await settle();
    await openFirstMessage();
    openShortcuts({ folders: [], canCompose: true });
    // The dialog is what is in front, and it answers Escape itself; a second
    // answer here would have closed the message behind it as well.
    press('Escape');
    expect(root.querySelector('.app-frame').classList.contains('reading')).toBe(true);
    document.querySelectorAll('.modal-root').forEach((node) => node.remove());
  });

  it('does nothing on a for a message with nobody else on it', async () => {
    mount();
    await settle();
    await openFirstMessage();
    // Reply all is only offered when it would differ from Reply, and the key
    // is offered on exactly the same terms.
    const offered = [...root.querySelectorAll('.msg-reply .btn')]
      .some((button) => button.textContent.includes('Reply all'));
    press('a');
    expect(composed.length).toBe(offered ? 1 : 0);
  });

  it('archives the open message on e', async () => {
    mount();
    await settle();
    const subject = subjectOf(rows()[0]);
    await openFirstMessage();

    press('e');
    await settle(350);
    expect(rows().map(subjectOf)).not.toContain(subject);
  });

  it('archives only the open message, not whatever is still ticked behind it', async () => {
    mount();
    await settle();
    const open = subjectOf(rows()[0]);
    // A row's own `e` reaches for the selection, because a ticked list is what
    // a row is about. A message on screen is not, and the message toolbar's
    // Archive has always acted on it alone.
    const ticked = subjectOf(rows()[2]);
    const check = rows()[2].querySelector('.row-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));

    await openFirstMessage();
    press('e');
    await settle(350);

    const left = rows().map(subjectOf);
    expect(left).not.toContain(open);
    expect(left).toContain(ticked);
  });

  it('leaves the reply keys alone until the message has been read', async () => {
    mount();
    await settle();
    // Nothing is open, so there is nothing to answer.
    expect(press('r').defaultPrevented).toBe(false);
    expect(composed).toHaveLength(0);
  });
});

describe('the sheet', () => {
  it('names only the folders this account has', () => {
    const modal = openShortcuts({
      folders: [{ id: 'inbox', label: 'Inbox' }, { id: 'trash', label: 'Trash' }],
    });
    const text = document.querySelector('.shortcuts').textContent;
    expect(text).toContain('Go to Inbox');
    expect(text).toContain('Go to Trash');
    expect(text).not.toContain('Go to Sent');
    modal.close();
  });

  it('leaves out what an account that cannot send would never do', () => {
    const modal = openShortcuts({ folders: [], canCompose: false });
    const text = document.querySelector('.shortcuts').textContent;
    expect(text).not.toContain('Reply');
    expect(text).not.toContain('Write a message');
    // What is left still works, and is still printed.
    expect(text).toContain('Archive');
    modal.close();
  });

  it('prints a chord as a sequence rather than as a combination', () => {
    const modal = openShortcuts({ folders: [{ id: 'inbox', label: 'Inbox' }] });
    const row = [...document.querySelectorAll('.shortcut')]
      .find((node) => node.textContent.includes('Go to Inbox'));
    expect([...row.querySelectorAll('.shortcut-key')].map((k) => k.textContent)).toEqual(['g', 'i']);
    expect(row.querySelector('.shortcut-join').textContent).toBe('then');
    modal.close();
  });
});
