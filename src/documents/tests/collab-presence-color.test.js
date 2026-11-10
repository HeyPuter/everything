import { it, expect } from 'vitest';
import { CollabClient } from '../src/collab/client.js';
import { colorFor, PERSON_COLORS } from '../src/collab/protocol.js';

/**
 * A participant's presence entry is theirs to write: anything in it reaches everyone else's title bar (an avatar's
 * inline style) and canvas. A color that is not a plain hex color is not used as written.
 */
it('replaces a color in someone\'s presence that is not a plain hex color', () => {
  const client = new CollabClient({ transport: { presence() {} }, user: { id: 'me', name: 'Me' }, room: 'r1' });
  const tricks = ['red; background-image: url(https://example.com/track)', 'url(x)', '#12345g', '', 42, null];
  client.setRoster([
    ...tricks.map((color, i) => ({ session: `s${i}`, user: `u${i}`, name: `Person ${i}`, color, at: Date.now() })),
    { session: 'ok', user: 'u-ok', name: 'Fine', color: '#1E5AA8', at: Date.now() },
  ]);
  const people = client.people().filter(p => !p.me);
  for (const [i] of tricks.entries()) expect(people[i].color).toBe(colorFor(`u${i}`));
  expect(people.at(-1).color).toBe('#1E5AA8');
  expect(people.every(p => /^#[0-9a-f]{6}$/i.test(p.color))).toBe(true);
  expect(PERSON_COLORS).toContain(people[0].color);
});

/** Ten colors for everyone: two people here at once must not be told apart by name alone. */
it('gives each person here a color nobody else here has, and keeps it while they stay', () => {
  const me = 'me';
  const client = new CollabClient({ transport: { presence() {} }, user: { id: me, name: 'Me' }, room: 'r1' });
  // Ids whose own colors are all mine.
  const same = [];
  for (let i = 0; same.length < 3; i++) if (colorFor(`user${i}`) === client.color) same.push(`user${i}`);
  const entry = (id, i) => ({ session: `s${i}`, user: id, name: id, color: colorFor(id), at: Date.now() });
  client.setRoster(same.map(entry));
  const colors = () => client.people().map(p => p.color);
  expect(new Set(colors()).size).toBe(4);
  expect(colors().every(c => PERSON_COLORS.includes(c))).toBe(true);
  const before = client.people().find(p => p.session === 's2').color;
  // Someone leaving does not repaint the others.
  client.setRoster([entry(same[0], 0), entry(same[2], 2)]);
  expect(client.people().find(p => p.session === 's2').color).toBe(before);
  expect(new Set(colors()).size).toBe(3);
});
