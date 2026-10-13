import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { lastFind, findNext, decodeSpecial } from '../src/features/type/find.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Find and Replace', () => {
  let app;
  let doc;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    doc = app.editor.doc;
  });
  const add = (text, y = 100) => {
    const t = createText(text, 100, y);
    doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
    return t.id;
  };

  it('decodes caret codes for special characters', () => {
    expect(decodeSpecial('a^tb^pc^^d^q')).toBe('a\tb\nc^d^q');
    expect(decodeSpecial('^_^8')).toBe('—•');
  });

  it('searches backwards and wraps', () => {
    const a = add('cat and cat');
    const b = add('a cat', 200);
    Object.assign(lastFind, { query: 'cat', matchCase: false, wholeWord: false, backwards: true, current: null });
    expect(findNext(app)).toBe('found');
    expect(app.typeSession.id).toBe(b);
    expect(app.typeSession.range()).toEqual([2, 5]);
    expect(findNext(app)).toBe('found');
    expect(app.typeSession.id).toBe(a);
    expect(app.typeSession.range()).toEqual([8, 11]);
    expect(findNext(app)).toBe('found');
    expect(app.typeSession.range()).toEqual([0, 3]);
    expect(findNext(app)).toBe('found');
    expect(app.typeSession.id).toBe(b);
    Object.assign(lastFind, { backwards: false, query: '' });
  });

  it('replaces all with special characters from the menu', async () => {
    const a = add('one, two');
    const done = app.commands.run('edit.findReplace');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    dlg.querySelector('#fr-find').value = ', ';
    const repl = dlg.querySelector('#fr-repl');
    repl.value = '';
    const menu = dlg.querySelectorAll('.fr-special')[1];
    menu.value = '^t';
    menu.dispatchEvent(new Event('change'));
    expect(repl.value).toBe('^t');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Replace All').click();
    expect(doc.get(a).text).toBe('one\ttwo');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Done').click();
    await done;
  });
});

describe('Adjust Colors', () => {
  it('adjusts gray colors in Grayscale mode and converts others when asked', async () => {
    const { adjustColor } = await import('../src/features/paint/edit-colors.js');
    expect(adjustColor('#808080', 'grayscale', { gray: 10 })).not.toBe('#808080');
    expect(adjustColor('#ff0000', 'grayscale', { gray: 10 })).toBe('#ff0000');
    const out = adjustColor('#ff0000', 'grayscale', { gray: 0, convert: true });
    expect(out.slice(1, 3)).toBe(out.slice(3, 5));
    expect(adjustColor('#ffffff', 'grayscale', { gray: 100 })).toBe('#000000');
  });
});
