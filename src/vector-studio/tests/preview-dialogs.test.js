import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  const app = await bootAppWithFeatures();
  app.newDocument();
  const doc = app.editor.doc;
  const n = createPath(rectangle(100, 100, 100, 50), true, { fill: { type: 'solid', color: '#cc3333' }, stroke: { type: 'solid', color: '#3333cc' }, strokeWidth: 2 });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  app.editor.select([n.id]);
  return { app, doc, id: n.id };
}

/** Change something in the open dialog so its preview applies. */
function tweak(dlg) {
  const prev = [...dlg.querySelectorAll('input[type=checkbox]')].find((c) => /preview/i.test(dlg.querySelector(`label[for="${c.id}"]`)?.textContent || ''));
  if (prev && !prev.checked) {
    prev.checked = true;
    prev.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const range = dlg.querySelector('input[type=range]');
  if (range) {
    range.value = String(Number(range.min) < 0 ? -60 : Number(range.max));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const num = [...dlg.querySelectorAll('input[type=text], input:not([type])')].find((i) => !i.readOnly);
  if (num) {
    num.value = '30';
    num.dispatchEvent(new Event('input', { bubbles: true }));
    num.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function close(dlg, how) {
  if (how === 'cancel') [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  else if (how === 'x') dlg.querySelector('.dialog-close').click();
  else if (how === 'escape') dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
  else [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
}

const DIALOGS = ['color.saturate', 'color.adjust', 'color.recolor', 'effect.dropShadow', 'effect.gaussianBlur', 'object.transform.rotate', 'object.transform.scale', 'object.transform.move'];

describe('Preview dialogs', () => {
  for (const cmd of DIALOGS) {
    for (const how of ['cancel', 'escape', 'x', 'ok']) {
      it(`${cmd} closes its preview cleanly on ${how}`, async () => {
        const { app, doc, id } = await setup();
        const before = doc.get(id);
        const undo0 = doc.undoStack.length;
        const done = app.commands.run(cmd);
        await tick();
        const dlg = document.querySelector('dialog[open]');
        expect(dlg).toBeTruthy();
        tweak(dlg);
        await tick();
        // The preview shows on the artwork while the dialog is up.
        expect(doc.get(id)).not.toBe(before);
        close(dlg, how);
        await done;
        await tick();
        expect(document.querySelector('dialog[open]')).toBeNull();
        expect(doc.tx).toBeNull();
        if (how === 'ok') {
          expect(doc.undoStack.length).toBe(undo0 + 1);
          expect(doc.get(id)).not.toBe(before);
        } else {
          expect(doc.undoStack.length).toBe(undo0);
          const n = doc.get(id);
          expect([n.fill, n.stroke, n.anchors, n.effects]).toEqual([before.fill, before.stroke, before.anchors, before.effects]);
        }
      });
    }
  }
});

describe('Preview dialogs and outside actions', () => {
  it('closing the app window cancels an open preview dialog before asking to save', async () => {
    const { installPuterHooks } = await import('../src/features/files/index.js');
    const { app, doc, id } = await setup();
    const before = doc.get(id);
    let onClose = null;
    const seen = [];
    const fake = {
      env: 'app',
      editors: app.editors,
      activate: () => {},
      closeDocument: async (ed) => (seen.push({ tx: ed.doc.tx, fill: ed.doc.get(id).fill }), false),
      puter: { ui: { onWindowClose: (fn) => (onClose = fn), setWindowTitle: () => {} } },
    };
    installPuterHooks(fake, {});
    const done = app.commands.run('color.saturate');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    tweak(dlg);
    expect(doc.tx).not.toBeNull();
    await onClose();
    await done;
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(seen).toEqual([{ tx: null, fill: before.fill }]);
    expect(doc.tx).toBeNull();
  });

  it('a file dropped while a dialog is open is ignored without navigating away', async () => {
    const { app, doc } = await setup();
    const done = app.commands.run('color.saturate');
    await tick();
    const opened = [];
    app.on('active-editor', (e) => opened.push(e));
    const notes = [];
    app.notify = (m) => notes.push(m);
    const editors = app.editors.length;
    const drop = new Event('drop', { cancelable: true, bubbles: true });
    drop.dataTransfer = { types: ['Files'], items: [{ kind: 'file', getAsFile: () => new File(['<svg/>'], 'a.vstudio') }] };
    window.dispatchEvent(drop);
    await new Promise((r) => setTimeout(r, 400));
    expect(drop.defaultPrevented).toBe(true);
    // Nothing tried to open it (no new tab, no error dialog on top).
    expect(document.querySelectorAll('dialog[open]').length).toBe(1);
    expect(opened).toEqual([]);
    expect(notes).toEqual([]);
    expect(app.editors.length).toBe(editors);
    document.querySelector('dialog[open] .dialog-close').click();
    await done;
    expect(doc.tx).toBeNull();
  });
});

describe('Edit Colors previews', () => {
  it('put extra fills back when the preview returns to no change', async () => {
    const { app, doc, id } = await setup();
    const extra = { type: 'fill', fill: { type: 'solid', color: '#cc3333' } };
    doc.transact('Stack', () => doc.update(id, { appearance: [{ type: 'fill', base: true }, { type: 'stroke', base: true }, extra] }));
    const before = doc.get(id);
    const done = app.commands.run('color.saturate');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    tweak(dlg);
    expect(doc.get(id).appearance[2].fill.color).not.toBe('#cc3333');
    const range = dlg.querySelector('input[type=range]');
    range.value = '0';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(doc.get(id).appearance).toEqual(before.appearance);
    close(dlg, 'ok');
    await done;
    expect(doc.get(id).appearance).toEqual(before.appearance);
    expect(doc.get(id).fill).toEqual(before.fill);
  });
});
