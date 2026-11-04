// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';

// Counts how often the ribbon works the recipient list out: each Mailings control asked for the merged records,
// which read every row of the list again, about twenty times per refresh (a refresh follows each keystroke).
const calls = vi.hoisted(() => ({ records: 0 }));
vi.mock('../src/engine/merge-fields.js', async original => {
  const real = await original();
  return { ...real, mergeRecords: list => { calls.records++; return real.mergeRecords(list); } };
});
const { createMailings } = await import('../src/views/mailings.js');
const { emptyRecipientList } = await import('../src/engine/merge-fields.js');

it('works the recipient list out once per list, not for every Mailings control at every refresh', async () => {
  const list = emptyRecipientList(['First Name', 'City']);
  list.rows = Array.from({ length: 3000 }, (_, i) => ({ values: [`Ada ${i}`, 'Oslo'], included: true }));
  const pkg = { mailMerge: { type: 'formLetters', activeRecord: 2, preview: false, list, mapping: {}, source: null } };
  const engine = { session: { body: { text: '', tables: [] }, path: null }, focus() {} };
  const mailings = createMailings({ editor: () => engine, pkg: () => pkg, error: e => { throw e; } });
  // The merge modules load in the background.
  await vi.waitFor(() => expect(mailings.extendMenu('tools').length).toBeGreaterThan(0));
  await new Promise(resolve => setTimeout(resolve, 50));
  const states = [];
  const kit = {
    command: (label) => Object.assign(document.createElement('button'), { textContent: label }),
    menuButton: (label) => Object.assign(document.createElement('button'), { textContent: label }),
    rows: (...groups) => groups,
    when: (control, enabled, pressed) => { states.push({ control, enabled, pressed }); return control; },
  };
  mailings.extraTabs(kit);
  const refresh = () => { for (const { control, enabled, pressed } of states) { control.disabled = !enabled(); if (pressed) control.setAttribute('aria-pressed', pressed()); } };
  calls.records = 0;
  for (let i = 0; i < 5; i++) refresh();
  expect(states.find(s => s.control.textContent === 'Next Record').control.disabled).toBe(false);
  expect(states.find(s => s.control.textContent === 'First Record').control.disabled).toBe(false);
  expect(calls.records).toBeLessThanOrEqual(1);
  // A changed list (a recipient left out) is read again.
  pkg.mailMerge = { ...pkg.mailMerge, list: { ...list, rows: list.rows.map((row, i) => i ? row : { ...row, included: false }) } };
  calls.records = 0;
  refresh();
  expect(calls.records).toBe(1);
  expect(states.find(s => s.control.getAttribute('aria-label') === 'Go to record').control.max).toBe('2999');
});
