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
