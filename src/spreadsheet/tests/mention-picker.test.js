// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { attachMentionPicker, mentionQuery, matchPeople, closeMentionPickers } from '../src/ui/mention-picker.js';
import { findMentions } from '../src/core/mentions.js';

const PEOPLE = [
  { name: 'ana', user: 'ana', hint: 'Has access to the file' },
  { name: 'anton', user: 'anton' },
  { name: 'Ben Ode', email: 'ben@example.com' },
];

afterEach(() => { closeMentionPickers(); document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 0));

async function type(area, text) {
  area.value += text;
  area.setSelectionRange(area.value.length, area.value.length);
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(); await flush();
}
const key = (area, k) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  area.dispatchEvent(e);
  return e;
};
const options = () => [...document.querySelectorAll('.mention-list [role="option"]')].map((o) => o.querySelector('.mention-name').textContent);

function setup() {
  const area = document.createElement('textarea');
  document.body.append(area);
  area.focus();
  const pick = attachMentionPicker(area, { people: async () => PEOPLE });
  return { area, pick };
}

describe('the mention query', () => {
  it('is the @word being typed at the caret', () => {
    expect(mentionQuery('Hi @an', 6)).toEqual({ start: 3, query: 'an' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail ana@ex', 11)).toBeNull();
    expect(mentionQuery('Hi @kim@example.org', 19)).toEqual({ start: 3, query: 'kim@example.org' });
    expect(mentionQuery('Hi @ana done', 12)).toBeNull();
  });

  it('matches people by name, username or address, and offers what was typed', () => {
    expect(matchPeople(PEOPLE, 'an').map((p) => p.name)).toEqual(['ana', 'anton']);
    expect(matchPeople(PEOPLE, 'ode').map((p) => p.name)).toEqual(['Ben Ode']);
    expect(matchPeople(PEOPLE, 'ben@').map((p) => p.name)).toEqual(['Ben Ode']);
    expect(matchPeople(PEOPLE, 'zoe@example.org').at(-1)).toMatchObject({ name: 'zoe@example.org', email: 'zoe@example.org', typed: true });
    expect(matchPeople(PEOPLE, 'zoe').at(-1)).toMatchObject({ name: 'zoe', user: 'zoe', typed: true });
  });
});

describe('the picker', () => {
  it('lists people on @, narrows as more is typed, and writes the one chosen', async () => {
    const { area, pick } = setup();
    await type(area, 'Please check, @');
    expect(options()).toEqual(['ana', 'anton', 'Ben Ode']);
    expect(area.getAttribute('aria-expanded')).toBe('true');
    await type(area, 'an');
    expect(options()).toEqual(['ana', 'anton']);
    key(area, 'ArrowDown');
    expect(area.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    const enter = key(area, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(area.value).toBe('Please check, @anton ');
    expect(pick.picked).toEqual([{ name: 'anton', user: 'anton' }]);
    expect(document.querySelector('.mention-list')).toBeNull();
    expect(findMentions(area.value, pick.picked)).toEqual([expect.objectContaining({ name: 'anton', user: 'anton', start: 14, length: 6 })]);
  });

  it('offers a typed address and closes on Escape without changing the text', async () => {
    const { area, pick } = setup();
    await type(area, '@zoe@example.org');
    expect(options().at(-1)).toBe('Mention zoe@example.org');
    key(area, 'Escape');
    expect(document.querySelector('.mention-list')).toBeNull();
    expect(area.value).toBe('@zoe@example.org');
    await type(area, ' and @Ben');
    key(area, 'Tab');
    expect(area.value).toBe('@zoe@example.org and @Ben Ode ');
    expect(pick.picked).toEqual([{ name: 'Ben Ode', email: 'ben@example.com' }]);
  });

  it('lets keys through when no list is open', async () => {
    const { area } = setup();
    await type(area, 'plain text');
    expect(key(area, 'Enter').defaultPrevented).toBe(false);
  });
});

// The list kept the @word it was opened for while the caret moved away from it: with "@an" typed, Home or the
// arrows put the caret elsewhere, and Enter then wrote the person over the text from the @ to the caret's new
// place ("@ana" put in front of the text that followed, or the text before the caret lost). The list follows
// the caret as it follows typing, and a choice is written where the @word now is.
describe('the picker as the caret moves', () => {
  const caretKey = (area, k, at) => {
    key(area, k);
    area.setSelectionRange(at, at);
    area.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
  };
  it('closes when the caret leaves the @word, leaving Enter to the box', async () => {
    const { area, pick } = setup();
    await type(area, 'Hi @an');
    expect(options()).toEqual(['ana', 'anton']);
    caretKey(area, 'Home', 0);
    await flush(); await flush();
    expect(document.querySelector('.mention-list')).toBeNull();
    const enter = key(area, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(area.value).toBe('Hi @an');
    expect(pick.picked).toEqual([]);
  });

  it('narrows to the part of the @word before the caret', async () => {
    const { area } = setup();
    await type(area, '@anto');
    expect(options()).toEqual(['anton']);
    caretKey(area, 'ArrowLeft', 4);
    caretKey(area, 'ArrowLeft', 3);
    await flush(); await flush();
    expect(options()).toEqual(['ana', 'anton']);
  });

  // Chosen with the caret moved back inside the @word, the person took the place of the letters before the caret
  // alone: "@an|to" with anton chosen gave "@anton to", the rest of the word left behind the name.
  it('writes the person chosen over the whole @word, not only the part before the caret', async () => {
    const { area } = setup();
    await type(area, 'Hi @anto');
    caretKey(area, 'ArrowLeft', 7);
    caretKey(area, 'ArrowLeft', 6);
    await flush(); await flush();
    expect(options()).toEqual(['ana', 'anton']);
    key(area, 'ArrowDown');
    expect(key(area, 'Enter').defaultPrevented).toBe(true);
    expect(area.value).toBe('Hi @anton ');
    // Clicked into, with text after the word: that stays.
    area.value = 'Hi @anto see this';
    area.setSelectionRange(6, 6);
    area.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush(); await flush();
    expect(options()).toEqual(['ana', 'anton']);
    key(area, 'ArrowDown');
    expect(key(area, 'Enter').defaultPrevented).toBe(true);
    expect(area.value).toBe('Hi @anton see this');
    expect(area.selectionStart).toBe(9);
  });
});
