// The Script Editor: type, run (errors with their line), save to the Scripts menu, open examples.
import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function openEditor() {
  app.commands.run('file.scriptEditor');
  for (let i = 0; i < 50; i++) {
    const d = document.querySelector('dialog[open]');
    if (d) return d;
    await tick(10);
  }
  return null;
}

const button = (dlg, label) =>
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === label);

describe('Script Editor', () => {
  it('runs the typed script and shows an error with its line, selecting that line', async () => {
    app.newDocument();
    const dlg = await openEditor();
    const code = dlg.querySelector('textarea');
    code.value = 'const a = 1;\nnope();\n';
    code.dispatchEvent(new Event('input'));
    button(dlg, 'Run').click();
    // While it runs, Run turns into Stop.
    expect(button(dlg, 'Stop')).toBeTruthy();
    const frame = document.querySelector('iframe[sandbox]');
    // The script side (the sandboxed frame in a browser) reports the failure.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { __vs: 'done', error: 'nope is not defined', line: 2 },
        source: frame.contentWindow,
      }),
    );
    await tick(0);
    const out = dlg.querySelector('.script-editor-output');
    expect(out.textContent).toBe('Line 2: nope is not defined');
    expect(out.classList.contains('error')).toBe(true);
    expect(code.value.slice(code.selectionStart, code.selectionEnd)).toBe('nope();');
    expect(button(dlg, 'Run')).toBeTruthy();
    button(dlg, 'Close').click();
    await tick(0);
  });

  it('stops a running script with the Stop button', async () => {
    app.newDocument();
    const dlg = await openEditor();
    button(dlg, 'Run').click();
    button(dlg, 'Stop').click();
    await tick(0);
    expect(dlg.querySelector('.script-editor-output').textContent).toMatch(/^Stopped/);
    expect(document.querySelector('iframe[sandbox]')).toBeNull();
    button(dlg, 'Close').click();
    await tick(0);
  });

  it('keeps the draft, saves the script to File > Scripts and opens built-in scripts', async () => {
    let dlg = await openEditor();
    dlg.querySelector('.script-editor-name').value = 'Count';
    dlg.querySelector('.script-editor-name').dispatchEvent(new Event('input'));
    const code = dlg.querySelector('textarea');
    code.value = 'return 42;';
    code.dispatchEvent(new Event('input'));
    button(dlg, 'Save to Menu').click();
    expect(app.prefs.get('recentScripts')[0]).toEqual({ name: 'Count', source: 'return 42;' });
    const items = app.menuSources.get('scripts')(app);
    expect(items.some((i) => i.label === 'Count')).toBe(true);
    button(dlg, 'Close').click();
    await tick(0);
    // Reopened, the editor shows what was typed last.
    dlg = await openEditor();
    expect(dlg.querySelector('textarea').value).toBe('return 42;');
    const picker = dlg.querySelector('.script-editor-open');
    const opt = [...picker.options].find((o) => o.textContent === 'Select Smallest Object');
    picker.value = opt.value;
    picker.dispatchEvent(new Event('change'));
    expect(dlg.querySelector('textarea').value).toMatch(/vs\.area/);
    expect(dlg.querySelector('.script-editor-name').value).toBe('Select Smallest Object');
    button(dlg, 'Close').click();
    await tick(0);
  });
});
