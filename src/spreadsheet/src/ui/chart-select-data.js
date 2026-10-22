/**
 * Select Data Source: the chart data range, Switch Row/Column, the legend entries (series)
 * to add, edit, remove and reorder, the horizontal (category) axis labels, and Hidden and Empty Cells.
 * Editing series one by one gives the chart references of its own for each, as the file stores them.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { chartData } from '../core/charts.js';
import { rangeName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';
import { chartSeriesSources, reorderSeriesFormatting, seriesSourcesPatch } from '../core/chart-design.js';

const stripEquals = text => String(text || '').trim().replace(/^=/, '').trim();
const asFormula = ref => (ref ? `=${ref}` : '');
// Each legend entry remembers the place its series had when the dialog opened (or the range last changed), so
// the formatting kept by place follows a series that is moved or has others removed before it.
const numbered = sources => sources.map((s, i) => ({ ...s, from: i }));

export function openSelectDataDialog(ctx, chart) {
  const { wb } = ctx, sheetId = ctx.sheetId(), sheet = wb.sheet(sheetId);
  const xy = chart.type === 'scatter' || chart.type === 'bubble';
  const state = {
    range: chart.sourceRefs?.length ? null : { ...chart.range },
    seriesIn: chart.seriesIn,
    sources: numbered(chartSeriesSources(wb, sheetId, chart)),
    ownRefs: !!chart.sourceRefs?.length,
    blanks: chart.appearance?.radar?.blanks || chart.appearance?.blanks || 'gap',
    includeHidden: !!chart.includeHidden,
  };
  let selected = 0;
  const draft = () => (state.ownRefs ? { ...chart, sourceRefs: state.sources } : { ...chart, range: state.range, seriesIn: state.seriesIn, sourceRefs: undefined });
  const resolveName = s => {
    if (!s.nameRef) return s.name || '';
    const ref = wb.rangeFromText(sheetId, s.nameRef);
    return ref ? wb.getDisplay(ref.sheetId, ref.range.r1, ref.range.c1) : s.name || s.nameRef;
  };
  const rangeText = () => (state.ownRefs ? '' : `=${quoteSheet(sheet.name)}!${rangeName(state.range).split(':').map(p => p.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2')).join(':')}`);

  const error = el('p.field-error', { role: 'alert', hidden: true });
  const rangeInput = el('input.input', { type: 'text', 'aria-label': 'Chart data range', spellcheck: false, autocomplete: 'off' });
  const seriesList = el('div.select-data-list', { role: 'listbox', 'aria-label': 'Legend Entries (Series)' });
  const categoryList = el('div.select-data-list', { role: 'list', 'aria-label': 'Category Labels' });
  const switchBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => {
    if (state.ownRefs) return;
    const data = chartData(wb, sheetId, draft());
    state.seriesIn = data.orientation === 'rows' ? 'cols' : 'rows';
    state.sources = numbered(chartSeriesSources(wb, sheetId, draft()));
    render();
  } }, el('span', { html: icon('switchRowCol', 16) }), ' Switch Row/Column');

  const fail = msg => { error.textContent = msg; error.hidden = !msg; };
  rangeInput.addEventListener('change', () => {
    const parsed = wb.rangeFromText(sheetId, stripEquals(rangeInput.value));
    if (!parsed || parsed.sheetId !== sheetId) { fail('Enter a range on this sheet, such as =Sheet1!$A$1:$C$5'); return; }
    const r = parsed.range;
    if (r.r2 - r.r1 + 1 > 5000 || r.c2 - r.c1 + 1 > 200) { fail('That range is too large to chart'); return; }
    fail('');
    state.range = r; state.ownRefs = false;
    state.sources = numbered(chartSeriesSources(wb, sheetId, draft()));
    render();
  });

  /** The Edit Series dialog: a name (a cell or text) and the values (and x values, sizes). */
  function editSeries(index = null) {
    const s = index == null ? { name: '', nameRef: '', categories: state.sources[0]?.categories || '', values: '' } : state.sources[index];
    const nameInput = el('input.input', { type: 'text', 'aria-label': 'Series name', value: s.nameRef ? asFormula(s.nameRef) : s.name || '' });
    const xInput = el('input.input', { type: 'text', 'aria-label': 'Series X values', value: asFormula(s.categories) });
    const valuesInput = el('input.input', { type: 'text', 'aria-label': xy ? 'Series Y values' : 'Series values', value: asFormula(s.values) });
    const sizeInput = el('input.input', { type: 'text', 'aria-label': 'Series bubble size', value: asFormula(s.sizes) });
    const problem = el('p.field-error', { role: 'alert', hidden: true });
    const vector = (text, label, optional = false) => {
      const ref = stripEquals(text);
      if (!ref) return optional ? '' : { error: `Enter the ${label}` };
      const r = wb.rangeFromText(sheetId, ref)?.range;
      if (!r) return { error: `The ${label} must be a reference, such as =${quoteSheet(sheet.name)}!$B$2:$B$5` };
      if (r.r1 !== r.r2 && r.c1 !== r.c2) return { error: `The ${label} must be one row or one column` };
      return ref;
    };
    const submit = e => {
      e.preventDefault();
      const nameText = nameInput.value.trim();
      const nameRef = nameText.startsWith('=') ? stripEquals(nameText) : '';
      if (nameRef && !wb.rangeFromText(sheetId, nameRef)) { problem.textContent = 'The series name must be text or a cell reference'; problem.hidden = false; return; }
      const values = vector(valuesInput.value, xy ? 'Y values' : 'series values');
      const categories = xy ? vector(xInput.value, 'X values', true) : s.categories;
      const sizes = chart.type === 'bubble' ? vector(sizeInput.value, 'bubble sizes') : undefined;
      const bad = [values, categories, sizes].find(v => v && typeof v === 'object');
      if (bad) { problem.textContent = bad.error; problem.hidden = false; return; }
      const next = { name: nameRef ? '' : nameText, nameRef, categories: categories || '', values, ...(sizes ? { sizes } : {}), from: index == null ? null : s.from };
      if (index == null) { state.sources.push(next); selected = state.sources.length - 1; } else state.sources[index] = next;
      state.ownRefs = true;
      modal.close();
      render();
    };
    const content = el('form.chart-move-form', { onsubmit: submit },
      el('label.field', {}, el('span.field-label', {}, 'Series name:'), nameInput),
      xy ? el('label.field', {}, el('span.field-label', {}, 'Series X values:'), xInput) : null,
      el('label.field', {}, el('span.field-label', {}, xy ? 'Series Y values:' : 'Series values:'), valuesInput),
      chart.type === 'bubble' ? el('label.field', {}, el('span.field-label', {}, 'Series bubble size:'), sizeInput) : null,
      problem,
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
    const modal = openModal({ title: 'Edit Series', content, initialFocus: nameInput });
  }

  function editCategories() {
    const input = el('input.input', { type: 'text', 'aria-label': 'Axis label range', value: asFormula(state.sources[0]?.categories) });
    const problem = el('p.field-error', { role: 'alert', hidden: true });
    const submit = e => {
      e.preventDefault();
      const ref = stripEquals(input.value);
      const r = ref ? wb.rangeFromText(sheetId, ref)?.range : null;
      if (ref && (!r || (r.r1 !== r.r2 && r.c1 !== r.c2))) { problem.textContent = 'Choose one row or column of labels'; problem.hidden = false; return; }
      state.sources = state.sources.map(s => ({ ...s, categories: ref }));
      state.ownRefs = true;
      modal.close();
      render();
    };
    const content = el('form.chart-move-form', { onsubmit: submit }, el('label.field', {}, el('span.field-label', {}, 'Axis label range:'), input), problem,
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
    const modal = openModal({ title: 'Axis Labels', content, initialFocus: input });
  }

  function hiddenAndEmpty() {
    const radios = [['gap', 'Gaps'], ['zero', 'Zero'], ['span', 'Connect data points with line']].map(([value, label]) => {
      const input = el('input', { type: 'radio', name: 'select-data-blanks', value, checked: state.blanks === value });
      return { input, row: el('label.check', {}, input, el('span', {}, label)) };
    });
    const hidden = el('input', { type: 'checkbox', checked: state.includeHidden });
    const submit = e => { e.preventDefault(); state.blanks = radios.find(r => r.input.checked)?.input.value || 'gap'; state.includeHidden = hidden.checked; modal.close(); };
    const content = el('form.chart-move-form', { onsubmit: submit }, el('p.field-label', {}, 'Show empty cells as:'), ...radios.map(r => r.row),
      el('label.check', {}, hidden, el('span', {}, 'Show data in hidden rows and columns')),
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
    const modal = openModal({ title: 'Hidden and Empty Cell Settings', content, initialFocus: radios[0].input });
  }

  const move = step => {
    const to = selected + step;
    if (to < 0 || to >= state.sources.length) return;
    [state.sources[selected], state.sources[to]] = [state.sources[to], state.sources[selected]];
    selected = to; state.ownRefs = true; render();
  };
  const tool = (label, iconName, onclick, aria = label) => el('button.btn.btn-sm', { type: 'button', 'aria-label': aria, title: aria, onclick }, iconName ? el('span', { html: icon(iconName, 14) }) : null, label);
  const seriesTools = el('div.select-data-tools', {},
    tool('Add', 'plus', () => editSeries(null)),
    tool('Edit', null, () => { if (state.sources[selected]) editSeries(selected); }),
    tool('Remove', 'x', () => { if (state.sources.length > 1) { state.sources.splice(selected, 1); selected = Math.max(0, selected - 1); state.ownRefs = true; render(); } }),
    tool('', 'chevU', () => move(-1), 'Move Up'), tool('', 'chevD', () => move(1), 'Move Down'));
  const categoryTools = el('div.select-data-tools', {}, tool('Edit', null, () => editCategories(), 'Edit axis labels'));

  function render() {
    rangeInput.value = rangeText();
    rangeInput.placeholder = state.ownRefs ? 'The data range is too complex to be displayed' : '';
    switchBtn.disabled = state.ownRefs;
    seriesList.replaceChildren(...state.sources.map((s, i) => el('button.select-data-row', { type: 'button', role: 'option', 'aria-selected': String(i === selected),
      onclick: () => { selected = i; render(); }, ondblclick: () => editSeries(i) }, resolveName(s) || `Series${i + 1}`)));
    let categories = [];
    try { categories = chartData(wb, sheetId, draft()).categories; } catch { /* an invalid reference shows no labels */ }
    categoryList.replaceChildren(...categories.slice(0, 200).map(c => el('div.select-data-row', { role: 'listitem' }, c)));
  }

  const submit = e => {
    e.preventDefault();
    if (!state.sources.length) { fail('A chart needs at least one series'); return; }
    const patch = state.ownRefs ? { ...seriesSourcesPatch(chart, state.sources), ...reorderSeriesFormatting(chart, state.sources.map(s => s.from ?? null)) }
      : { range: state.range, seriesIn: state.seriesIn, sourceRefs: undefined };
    patch.includeHidden = state.includeHidden;
    if (chart.appearance) patch.appearance = { ...(patch.appearance || chart.appearance), blanks: state.blanks, ...(chart.appearance.radar ? { radar: { ...chart.appearance.radar, blanks: state.blanks } } : {}) };
    wb.updateChart(sheetId, chart.id, patch, 'Select data');
    modal.close();
  };
  const content = el('form.select-data-form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, 'Chart data range:'), rangeInput), error,
    el('div.row', { style: { justifyContent: 'center' } }, switchBtn),
    el('div.select-data-columns', {},
      el('div.select-data-box', {}, el('span.field-label', {}, 'Legend Entries (Series)'), seriesTools, seriesList),
      el('div.select-data-box', {}, el('span.field-label', {}, 'Category Labels'), categoryTools, categoryList)),
    el('div.row.row-end.select-data-foot', {}, el('button.btn.btn-ghost', { type: 'button', onclick: hiddenAndEmpty }, 'Hidden and Empty Cells'),
      el('div.row.select-data-actions', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK'))));
  render();
  const modal = openModal({ title: 'Select Data Source', content, wide: true, initialFocus: rangeInput, onClose: () => ctx.grid.focus() });
  return modal;
}
