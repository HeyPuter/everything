// @vitest-environment jsdom
import { it, expect, afterEach } from 'vitest';
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { openRecipientGrid } = await import('../src/views/mailings-recipients.js');

afterEach(() => document.body.replaceChildren());
const typeIn = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
const buttonNamed = name => [...document.querySelectorAll('button')].find(b => b.textContent === name);

// Delete Entry deleted the entry last focused, even after a search had hidden it: with "Ken" searched for and only
// Ken's entry shown, it deleted Rosa's, which the person could not see.
it('Delete Entry never deletes an entry the search hides', async () => {
  let saved = null;
  const list = { columns: ['First Name', 'City'], rows: [{ values: ['Rosa', 'Oslo'], included: true }, { values: ['Ken', 'Austin'], included: true }, { values: ['Mia', 'Rome'], included: true }], sort: [], filters: [] };
  openRecipientGrid({ list, onSave: next => { saved = next; } });
  const cell = label => document.querySelector(`input[aria-label="${label}"]`);
  cell('City, entry 1').dispatchEvent(new Event('focus'));
  typeIn(document.querySelector('input[aria-label="Find in list"]'), 'ken');
  expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  buttonNamed('Delete Entry').click();
  document.querySelector('form').requestSubmit();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(saved.rows.map(r => r.values[0])).toEqual(['Rosa', 'Mia']);
});

it('Delete Entry deletes the entry being edited', async () => {
  let saved = null;
  const list = { columns: ['First Name'], rows: [{ values: ['Rosa'], included: true }, { values: ['Ken'], included: true }, { values: ['Mia'], included: true }], sort: [], filters: [] };
  openRecipientGrid({ list, onSave: next => { saved = next; } });
  document.querySelector('input[aria-label="First Name, entry 2"]').dispatchEvent(new Event('focus'));
  buttonNamed('Delete Entry').click();
  document.querySelector('form').requestSubmit();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(saved.rows.map(r => r.values[0])).toEqual(['Rosa', 'Mia']);
});
