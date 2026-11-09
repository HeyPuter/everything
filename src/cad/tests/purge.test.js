// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { defaultLayer } from '../src/core/schema.js';
import { purgeDialog } from '../src/ui/dialogs.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

const base = { color: 256, linetype: 'ByLayer', lineweight: -1 };
const insert = (name) => ({ ...base, type: 'insert', layer: '0', name, x: 0, y: 0, sx: 1, sy: 1, rot: 0 });

/** A drawing where block B (defined first) is nested in block A. */
function nested(insertA) {
  const d = new Drawing();
  d.transaction('setup', () => {
    d.setTable('layers', 'Bolt', defaultLayer('Bolt'));
    d.setBlock('B', { name: 'B', bx: 0, by: 0, entities: [{ ...base, type: 'line', layer: 'Bolt', x1: 0, y1: 0, x2: 1, y2: 1 }] });
    d.setBlock('A', { name: 'A', bx: 0, by: 0, entities: [insert('B')] });
    if (insertA) d.add(insert('A'));
  });
  return d;
}

async function purge(d) {
  const p = purgeDialog({ doc: { drawing: d } });
  const dlg = document.querySelector('dialog[open]');
  const btn = [...dlg.querySelectorAll('button')].find((b) => /^Purge/.test(b.textContent));
  (btn || [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close')).click();
  await p;
}

describe('PURGE', () => {
  it('keeps blocks and layers used only inside nested blocks', async () => {
    const d = nested(true);
    await purge(d);
    expect(d.blocks.has('A')).toBe(true);
    expect(d.blocks.has('B')).toBe(true);
    expect(d.layers.has('Bolt')).toBe(true);
  });
  it('purges nested blocks and their layers when the outer block is unused', async () => {
    const d = nested(false);
    await purge(d);
    expect(d.blocks.has('A')).toBe(false);
    expect(d.blocks.has('B')).toBe(false);
    expect(d.layers.has('Bolt')).toBe(false);
  });
});
