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

describe('Recolor Artwork', () => {
  it('sets new colors from a rule and keeps preserved colors', async () => {
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const { preservedColor, randomSatBright } = await import('../src/features/paint/edit-colors-ui.js');
    expect(preservedColor('#ffffff', { white: true })).toBe(true);
    expect(preservedColor('#808080', { grays: true })).toBe(true);
    expect(preservedColor('#808080', { white: true, black: true })).toBe(false);
    expect(randomSatBright('#ff0000', () => 0.5)).not.toBe('#ff0000');
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const ids = [];
    doc.transact('r', () => {
      for (const [i, c] of ['#ff0000', '#ee1111', '#0000ff', '#ffffff'].entries()) {
        const n = createPath(rectangle(i * 20, 0, 10, 10), true, { fill: { type: 'solid', color: c }, stroke: null });
        doc.insert(n, app.editor.targetLayer().id);
        ids.push(n.id);
      }
    });
    app.editor.select(ids);
    const done = app.commands.run('color.recolor');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const white = [...dlg.querySelectorAll('.rc-preserve .check-row')].find((r) => r.textContent === 'White').querySelector('input');
    white.checked = true;
    white.dispatchEvent(new Event('change', { bubbles: true }));
    const rule = dlg.querySelector('#rc-rule');
    rule.value = 'reduce:1';
    rule.dispatchEvent(new Event('change'));
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    const fills = ids.map((id) => doc.get(id).fill.color);
    expect(fills[3]).toBe('#ffffff');
    expect(fills[2]).not.toBe('#0000ff');
  });
});
