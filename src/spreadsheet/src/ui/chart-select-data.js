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
import { t } from '../i18n/index.js';

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
  const rangeInput = el('input.input', { type: 'text', 'aria-label': t('chartSelectData.dataRange'), spellcheck: false, autocomplete: 'off' });
  const seriesList = el('div.select-data-list', { role: 'listbox', 'aria-label': t('chartSelectData.legendEntries') });
  const categoryList = el('div.select-data-list', { role: 'list', 'aria-label': t('chartSelectData.categoryLabels') });
  const switchBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => {
    if (state.ownRefs) return;
    const data = chartData(wb, sheetId, draft());
    state.seriesIn = data.orientation === 'rows' ? 'cols' : 'rows';
    state.sources = numbered(chartSeriesSources(wb, sheetId, draft()));
    render();
  } }, el('span', { html: icon('switchRowCol', 16) }), ' ', t('chartSelectData.switchRowColumn'));

  const fail = msg => { error.textContent = msg; error.hidden = !msg; };
  rangeInput.addEventListener('change', () => {
    const parsed = wb.rangeFromText(sheetId, stripEquals(rangeInput.value));
    if (!parsed || parsed.sheetId !== sheetId) { fail(t('chartSelectData.errors.range')); return; }
    const r = parsed.range;
    if (r.r2 - r.r1 + 1 > 5000 || r.c2 - r.c1 + 1 > 200) { fail(t('chartSelectData.errors.tooLarge')); return; }
    fail('');
    state.range = r; state.ownRefs = false;
    state.sources = numbered(chartSeriesSources(wb, sheetId, draft()));
    render();
  });

  /** The Edit Series dialog: a name (a cell or text) and the values (and x values, sizes). */
  function editSeries(index = null) {
    const s = index == null ? { name: '', nameRef: '', categories: state.sources[0]?.categories || '', values: '' } : state.sources[index];
    const nameInput = el('input.input', { type: 'text', 'aria-label': t('chartSelectData.seriesName'), value: s.nameRef ? asFormula(s.nameRef) : s.name || '' });
    const xInput = el('input.input', { type: 'text', 'aria-label': t('chartSelectData.seriesXValues'), value: asFormula(s.categories) });
    const valuesInput = el('input.input', { type: 'text', 'aria-label': xy ? t('chartSelectData.seriesYValues') : t('chartSelectData.seriesValues'), value: asFormula(s.values) });
    const sizeInput = el('input.input', { type: 'text', 'aria-label': t('chartSelectData.seriesBubbleSize'), value: asFormula(s.sizes) });
    const problem = el('p.field-error', { role: 'alert', hidden: true });
    // `kind` names the field in the message: xValues, yValues, seriesValues or bubbleSizes.
    const vector = (text, kind, optional = false) => {
      const ref = stripEquals(text);
      if (!ref) return optional ? '' : { error: t('chartSelectData.errors.enter', { kind }) };
      const r = wb.rangeFromText(sheetId, ref)?.range;
      if (!r) {
        return { error: t('chartSelectData.errors.reference', { kind, example: `=${quoteSheet(sheet.name)}!$B$2:$B$5` }) };
      }
      if (r.r1 !== r.r2 && r.c1 !== r.c2) return { error: t('chartSelectData.errors.oneRowOrColumn', { kind }) };
      return ref;
    };
    const submit = e => {
      e.preventDefault();
      const nameText = nameInput.value.trim();
      const nameRef = nameText.startsWith('=') ? stripEquals(nameText) : '';
      if (nameRef && !wb.rangeFromText(sheetId, nameRef)) { problem.textContent = t('chartSelectData.errors.name'); problem.hidden = false; return; }
      const values = vector(valuesInput.value, xy ? 'yValues' : 'seriesValues');
      const categories = xy ? vector(xInput.value, 'xValues', true) : s.categories;
      const sizes = chart.type === 'bubble' ? vector(sizeInput.value, 'bubbleSizes') : undefined;
      const bad = [values, categories, sizes].find(v => v && typeof v === 'object');
      if (bad) { problem.textContent = bad.error; problem.hidden = false; return; }
      const next = { name: nameRef ? '' : nameText, nameRef, categories: categories || '', values, ...(sizes ? { sizes } : {}), from: index == null ? null : s.from };
      if (index == null) { state.sources.push(next); selected = state.sources.length - 1; } else state.sources[index] = next;
      state.ownRefs = true;
      modal.close();
      render();
    };
    const content = el('form.chart-move-form', { onsubmit: submit },
      el('label.field', {}, el('span.field-label', {}, t('chartSelectData.seriesNameField')), nameInput),
      xy ? el('label.field', {}, el('span.field-label', {}, t('chartSelectData.seriesXValuesField')), xInput) : null,
      el('label.field', {}, el('span.field-label', {}, xy ? t('chartSelectData.seriesYValuesField') : t('chartSelectData.seriesValuesField')), valuesInput),
      chart.type === 'bubble' ? el('label.field', {}, el('span.field-label', {}, t('chartSelectData.seriesBubbleSizeField')), sizeInput) : null,
      problem,
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
    const modal = openModal({ title: t('chartSelectData.editSeries'), content, initialFocus: nameInput });
  }

  function editCategories() {
    const input = el('input.input', { type: 'text', 'aria-label': t('chartSelectData.axisLabelRange'), value: asFormula(state.sources[0]?.categories) });
    const problem = el('p.field-error', { role: 'alert', hidden: true });
    const submit = e => {
      e.preventDefault();
      const ref = stripEquals(input.value);
      const r = ref ? wb.rangeFromText(sheetId, ref)?.range : null;
      if (ref && (!r || (r.r1 !== r.r2 && r.c1 !== r.c2))) { problem.textContent = t('chartSelectData.errors.labels'); problem.hidden = false; return; }
      state.sources = state.sources.map(s => ({ ...s, categories: ref }));
      state.ownRefs = true;
      modal.close();
      render();
    };
    const content = el('form.chart-move-form', { onsubmit: submit }, el('label.field', {}, el('span.field-label', {}, t('chartSelectData.axisLabelRangeField')), input), problem,
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
    const modal = openModal({ title: t('chartSelectData.axisLabels'), content, initialFocus: input });
  }

  function hiddenAndEmpty() {
    const radios = [['gap', t('chartSelectData.gaps')], ['zero', t('chartSelectData.zero')], ['span', t('chartSelectData.connect')]].map(([value, label]) => {
      const input = el('input', { type: 'radio', name: 'select-data-blanks', value, checked: state.blanks === value });
      return { input, row: el('label.check', {}, input, el('span', {}, label)) };
    });
    const hidden = el('input', { type: 'checkbox', checked: state.includeHidden });
    const submit = e => { e.preventDefault(); state.blanks = radios.find(r => r.input.checked)?.input.value || 'gap'; state.includeHidden = hidden.checked; modal.close(); };
    const content = el('form.chart-move-form', { onsubmit: submit }, el('p.field-label', {}, t('chartSelectData.emptyCells')), ...radios.map(r => r.row),
      el('label.check', {}, hidden, el('span', {}, t('chartSelectData.includeHidden'))),
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
    const modal = openModal({ title: t('chartSelectData.hiddenEmptyTitle'), content, initialFocus: radios[0].input });
  }

  const move = step => {
    const to = selected + step;
    if (to < 0 || to >= state.sources.length) return;
    [state.sources[selected], state.sources[to]] = [state.sources[to], state.sources[selected]];
    selected = to; state.ownRefs = true; render();
  };
  const tool = (label, iconName, onclick, aria = label) => el('button.btn.btn-sm', { type: 'button', 'aria-label': aria, title: aria, onclick }, iconName ? el('span', { html: icon(iconName, 14) }) : null, label);
  const seriesTools = el('div.select-data-tools', {},
    tool(t('common.add'), 'plus', () => editSeries(null)),
    tool(t('common.edit'), null, () => { if (state.sources[selected]) editSeries(selected); }),
    tool(t('common.remove'), 'x', () => { if (state.sources.length > 1) { state.sources.splice(selected, 1); selected = Math.max(0, selected - 1); state.ownRefs = true; render(); } }),
    tool('', 'chevU', () => move(-1), t('chartSelectData.moveUp')), tool('', 'chevD', () => move(1), t('chartSelectData.moveDown')));
  const categoryTools = el('div.select-data-tools', {}, tool(t('common.edit'), null, () => editCategories(), t('chartSelectData.editAxisLabels')));

  function render() {
    rangeInput.value = rangeText();
    rangeInput.placeholder = state.ownRefs ? t('chartSelectData.tooComplex') : '';
    switchBtn.disabled = state.ownRefs;
    seriesList.replaceChildren(...state.sources.map((s, i) => el('button.select-data-row', { type: 'button', role: 'option', 'aria-selected': String(i === selected),
      onclick: () => { selected = i; render(); }, ondblclick: () => editSeries(i) }, resolveName(s) || `Series${i + 1}`)));
    let categories = [];
    try { categories = chartData(wb, sheetId, draft()).categories; } catch { /* an invalid reference shows no labels */ }
    categoryList.replaceChildren(...categories.slice(0, 200).map(c => el('div.select-data-row', { role: 'listitem' }, c)));
  }

  const submit = e => {
    e.preventDefault();
    if (!state.sources.length) { fail(t('chartSelectData.errors.noSeries')); return; }
    const patch = state.ownRefs ? { ...seriesSourcesPatch(chart, state.sources), ...reorderSeriesFormatting(chart, state.sources.map(s => s.from ?? null)) }
      : { range: state.range, seriesIn: state.seriesIn, sourceRefs: undefined };
    patch.includeHidden = state.includeHidden;
    if (chart.appearance) patch.appearance = { ...(patch.appearance || chart.appearance), blanks: state.blanks, ...(chart.appearance.radar ? { radar: { ...chart.appearance.radar, blanks: state.blanks } } : {}) };
    wb.updateChart(sheetId, chart.id, patch, t('chartSelectData.undo'));
    modal.close();
  };
  const content = el('form.select-data-form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, t('chartSelectData.dataRangeField')), rangeInput), error,
    el('div.row', { style: { justifyContent: 'center' } }, switchBtn),
    el('div.select-data-columns', {},
      el('div.select-data-box', {}, el('span.field-label', {}, t('chartSelectData.legendEntries')), seriesTools, seriesList),
      el('div.select-data-box', {}, el('span.field-label', {}, t('chartSelectData.categoryLabels')), categoryTools, categoryList)),
    el('div.row.row-end.select-data-foot', {}, el('button.btn.btn-ghost', { type: 'button', onclick: hiddenAndEmpty }, t('chartSelectData.hiddenEmpty')),
      el('div.row.select-data-actions', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, t('common.ok')))));
  render();
  const modal = openModal({ title: t('chartSelectData.title'), content, wide: true, initialFocus: rangeInput, onClose: () => ctx.grid.focus() });
  return modal;
}
