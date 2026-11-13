import { it, expect } from 'vitest';
import { openExportDialog } from '../src/dialogs/export.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import { openDialog } from '../src/ui/dialog.js';

it('focuses the available pattern range when exporting an empty song', async () => {
  document.body.innerHTML = '<button id="launch">Export audio</button>';
  const launch = document.getElementById('launch');
  launch.focus();
  const done = openExportDialog({
    store: new Store(newProject()),
    prefs: { get: () => ({ rate: 48000, bits: 16, tail: true }) },
  });
  const dialog = document.querySelector('.dlg-export');
  const pattern = dialog.querySelector('input[value="pattern"]');
  const focused = document.activeElement;
  dialog.querySelector('.dialog-head button').click();
  await done;
  expect(focused).toBe(pattern);
  expect(document.activeElement).toBe(launch);
});

it('keeps the primary button as the initial focus when there are no form controls', async () => {
  const done = openDialog({ title: 'Notice', body: 'Ready', buttons: [{ label: 'Cancel', value: null }, { label: 'Continue', value: true, primary: true }] });
  const primary = document.querySelector('.dialog .btn.primary');
  const focused = document.activeElement;
  primary.click();
  expect(await done).toBe(true);
  expect(focused).toBe(primary);
});
