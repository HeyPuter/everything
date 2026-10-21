import { describe, it, expect, afterEach } from 'vitest';
import { project } from './helpers.js';
import { newOptionSet, hiddenByOption, setEditingOption, makePrimary, acceptPrimary, deleteOption, optionsOf, optionable } from '../src/core/designopts.js';
import { hiddenByFilters } from '../src/core/graphics.js';

function twoOptions() {
  const p = project();
  const { doc, wall } = p;
  let set;
  let a;
  doc.transact('s', () => ({ set, opt: a } = newOptionSet(doc, 'Entrance')));
  const b = doc.transact('o', () => doc.add({ kind: 'designOption', setId: set.id, name: 'Option 2', primary: false }));
  const main = wall([0, 0], [6000, 0]);
  const wa = wall([0, 1000], [2000, 1000], { optionId: a.id });
  const wb = wall([0, 2000], [2000, 2000], { optionId: b.id });
  return { ...p, set, a, b, main, wa, wb, view: doc.all('plan')[0] };
}

afterEach(() => setEditingOption(null));

describe('design options', () => {
  it('shows the primary option unless a view or the edited option says otherwise', () => {
    const { doc, set, b, main, wa, wb, view } = twoOptions();
    const hidden = (el, v = doc.get(view.id)) => hiddenByOption(doc, v, doc.get(el.id));
    expect(hidden(main)).toBe(false);
    expect(hidden(wa)).toBe(false);
    expect(hidden(wb)).toBe(true);
    doc.transact('v', () => doc.update(view.id, { designOptions: { [set.id]: b.id } }));
    expect(hidden(wa)).toBe(true);
    expect(hiddenByFilters(doc, doc.get(view.id), doc.get(wb.id))).toBe(false);
    doc.transact('v', () => doc.update(view.id, { designOptions: {} }));
    setEditingOption(b.id);
    expect(hidden(wb)).toBe(false);
    expect(hidden(wa)).toBe(true);
  });

  it('keeps one primary option per set', () => {
    const { doc, set, a, b } = twoOptions();
    doc.transact('p', () => makePrimary(doc, b.id));
    expect(doc.get(a.id).primary).toBe(false);
    expect(doc.get(b.id).primary).toBe(true);
    doc.transact('d', () => deleteOption(doc, b.id));
    expect(doc.get(a.id).primary).toBe(true);
    expect(optionsOf(doc, set.id)).toHaveLength(1);
  });

  it('accepting the primary option merges it into the main model', () => {
    const { doc, set, a, wa, wb, view } = twoOptions();
    doc.transact('accept', () => acceptPrimary(doc, set.id));
    expect(doc.get(wa.id).optionId).toBeNull();
    expect(doc.has(wb.id)).toBe(false);
    expect(doc.has(a.id)).toBe(false);
    expect(doc.has(set.id)).toBe(false);
    expect(hiddenByOption(doc, doc.get(view.id), doc.get(wa.id))).toBe(false);
  });

  it('applies to model elements only', () => {
    const { doc, view, main } = twoOptions();
    expect(optionable(doc, doc.get(main.id))).toBe(true);
    expect(optionable(doc, doc.levels()[0])).toBe(false);
    expect(optionable(doc, { kind: 'text', viewId: view.id })).toBe(false);
  });
});
