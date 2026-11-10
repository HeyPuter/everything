// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { BlockLibrary } from '../src/ui/blocks.js';

// thumbnails draw on a later frame; jsdom has no canvas to draw them on
globalThis.requestAnimationFrame = () => 0;

afterEach(() => document.body.replaceChildren());

function palette(names) {
  const d = new Drawing();
  d.transaction('blocks', () => {
    for (const n of names) d.setBlock(n, { name: n, base: { x: 0, y: 0 }, entities: [] });
  });
  const bl = new BlockLibrary({ doc: { drawing: d }, run() {} });
  document.body.append(bl.el);
  bl.render();
  const more = (name) => bl.el.querySelector(`[aria-label="More actions for ${name}"]`);
  const insert = (name) => bl.el.querySelector(`[aria-label="Insert ${name}"]`);
  return { d, bl, more, insert };
}

describe('keyboard focus in the Blocks palette', () => {
  it('stays on the same control when the list is drawn again', () => {
    const { bl, more, insert } = palette(['A', 'B', 'C']);
    more('B').focus();
    bl.render();
    expect(document.activeElement).toBe(more('B'));
    insert('C').focus();
    bl.render();
    expect(document.activeElement).toBe(insert('C'));
  });

  it('moves to the next block after the focused one is deleted', () => {
    const { d, bl, more, insert } = palette(['A', 'B', 'C']);
    // Delete from the item menu: focus is back on its button when the list is redrawn.
    more('B').focus();
    d.transaction('Delete block', () => d.setBlock('B', null));
    bl.render();
    expect(document.activeElement).toBe(insert('C'));
    more('C').focus();
    d.transaction('Delete block', () => d.setBlock('C', null));
    bl.render();
    expect(document.activeElement).toBe(insert('A'));
    more('A').focus();
    d.transaction('Delete block', () => d.setBlock('A', null));
    bl.render();
    expect(document.activeElement).toBe(bl.search);
  });

  it('is not taken from elsewhere', () => {
    const { bl } = palette(['A', 'B']);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    bl.render();
    expect(document.activeElement).toBe(other);
  });
});
