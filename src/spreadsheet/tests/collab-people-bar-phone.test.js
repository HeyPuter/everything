// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createPeopleBar } from '../src/ui/coauthor.js';
import { stylesheet, declared } from './helpers/css.js';

const person = (n) => ({ session: `s${n}`, user: `u${n}`, username: `person${n}`, role: 'editor', state: null, at: n });
const client = (count) => ({ user: { uuid: 'me', username: 'me' }, people: new Map(Array.from({ length: count }, (_, i) => [`s${i}`, person(i)])) });

// In a shared workbook the title row held up to four faces and a "+N" beside the document's name. On a phone that row
// has no room for them: six people here took the name down to its first letter. Under 640px the faces give way to
// a count on the button that lists everyone (each still a click away from where they are).
it('counts everyone on the people button where a phone has no room for their faces', () => {
  const css = stylesheet('coauthor.css');
  expect(declared(css, '.collab-avatar', 'max-width: 640px').display).toBe('none');
  expect(declared(css, '.collab-more', 'max-width: 640px').display).toBe('none');
  expect(declared(css, '.collab-count', 'max-width: 640px').display).toBe('inline');
  expect(declared(css, '.collab-count', false).display).toBe('none');
  const bar = createPeopleBar({ client: client(6), wb: new Workbook(), jump: () => {} });
  expect(bar.el.querySelectorAll('.collab-avatar')).toHaveLength(4);
  const button = bar.el.querySelector('.collab-list-btn');
  expect(button.querySelector('.collab-more').textContent).toBe('+2');
  expect(button.querySelector('.collab-count').textContent).toBe('7');
  expect(button.getAttribute('aria-label')).toBe('Everyone here: 7 people');
  // Alone, there is nobody to count.
  expect(createPeopleBar({ client: client(0), wb: new Workbook(), jump: () => {} }).el.querySelector('.collab-count')).toBeNull();
});
