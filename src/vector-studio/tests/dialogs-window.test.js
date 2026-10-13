import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { shownTools, savedToolbars, setToolShown, toolSet } from '../src/features/workspace/window.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog[open]');
const button = (label) => [...dlg().querySelectorAll('button')].find((b) => b.textContent === label).click();

describe('Toolbars', () => {
  it('saves, edits, renames and deletes named toolbars', async () => {
    const app = await bootAppWithFeatures();
    await app.commands.run('window.toolbar.basic');
    const basic = shownTools(app);
    let done = app.commands.run('window.toolbar.new');
    await tick();
    const name = dlg().querySelector('input[type=text]');
    name.value = 'Lettering';
    button('OK');
    await done;
    expect(savedToolbars(app).map((t) => t.name)).toEqual(['Lettering']);
    expect(toolSet(app)).toBe('saved:Lettering');
    expect([...shownTools(app)].sort()).toEqual([...basic].sort());
    // Edit Toolbar changes the active saved toolbar.
    setToolShown(app, 'pen', false);
    expect(shownTools(app).has('pen')).toBe(false);
    expect(savedToolbars(app)[0].hidden).toContain('pen');
    expect(toolSet(app)).toBe('saved:Lettering');
    const items = app.menuSources.get('toolbarSets')(app);
    expect(items).toMatchObject([{ label: 'Lettering', checked: true }]);
    // Rename in Manage Toolbars keeps it active.
    done = app.commands.run('window.toolbar.manage');
    await tick();
    const input = dlg().querySelector('#mw-name');
    input.value = 'Type Work';
    input.dispatchEvent(new Event('input'));
    button('OK');
    await done;
    expect(toolSet(app)).toBe('saved:Type Work');
    // Deleting the active toolbar goes back to Advanced.
    done = app.commands.run('window.toolbar.manage');
    await tick();
    button('Delete');
    button('OK');
    await done;
    expect(savedToolbars(app)).toEqual([]);
    expect(toolSet(app)).toBe('advanced');
  });
});
