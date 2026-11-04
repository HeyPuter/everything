/**
 * Data ▸ Analyze ▸ Data Analysis: a list of the analysis tools, then a dialog for the one chosen with
 * its input ranges and options and where the results go: a range on a sheet, a new sheet, or a new
 * spreadsheet file. The computing is in core/analysis-tools.js; this is the form around it.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import * as P from '../lib/puter.js';
import * as S from '../core/selection.js';
import { colName } from '../core/cell.js';
import { typedNumber, numberShown } from './typed-number.js';
import { quoteSheet } from '../core/refs.js';
import { workbookToXlsx, stripExtension } from '../core/io.js';
import { t } from '../i18n/index.js';
import {
  TOOLS, readGroups, readBlock, anovaSingleFactor, anovaTwoFactorReplication, anovaTwoFactor, correlation, covariance,
  descriptiveStatistics, exponentialSmoothing, fTest, fourier, histogram, movingAverage, randomNumbers, rankAndPercentile,
  regression, sampling, tTest, zTest, writeAnalysisOutput, analysisWorkbook, outputOccupied, layoutSize, toolLabel,
} from '../core/analysis-tools.js';

const TOOL_HINTS = {
  anova1: 'analysisTools.hints.anova1',
  anova2rep: 'analysisTools.hints.anova2rep',
  anova2: 'analysisTools.hints.anova2',
  correlation: 'analysisTools.hints.correlation',
  covariance: 'analysisTools.hints.covariance',
  descriptive: 'analysisTools.hints.descriptive',
  smoothing: 'analysisTools.hints.smoothing',
  ftest: 'analysisTools.hints.ftest',
  fourier: 'analysisTools.hints.fourier',
  histogram: 'analysisTools.hints.histogram',
  moving: 'analysisTools.hints.moving',
  random: 'analysisTools.hints.random',
  rank: 'analysisTools.hints.rank',
  regression: 'analysisTools.hints.regression',
  sampling: 'analysisTools.hints.sampling',
  tpaired: 'analysisTools.hints.tpaired',
  tequal: 'analysisTools.hints.tequal',
  tunequal: 'analysisTools.hints.tunequal',
  ztest: 'analysisTools.hints.ztest',
};

const toolName = (id) => toolLabel(id);
/** A sentence that starts with a name read in mid-sentence: "the damping factor" opens it as "The damping factor". */
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** The selection as absolute reference text; a single cell stands for its data region. */
function selectionText(ctx, column = null) {
  const sel = ctx.range?.();
  let range = sel && (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) ? sel : ctx.dataRange?.() || sel;
  if (!range) return '';
  // A two-sample tool offers the block's first column as one sample and its second as the other.
  if (column != null) {
    if (range.c2 - range.c1 < 1) return column === 0 ? selectionText(ctx) : '';
    range = { ...range, c1: range.c1 + column, c2: range.c1 + column };
  }
  const a = (r, c) => `$${colName(c)}$${r + 1}`;
  return range.r1 === range.r2 && range.c1 === range.c2 ? a(range.r1, range.c1) : `${a(range.r1, range.c1)}:${a(range.r2, range.c2)}`;
}

/** Data Analysis: the list of tools. */
export function openDataAnalysis(ctx) {
  const list = el('select.select.da-list', { size: 12, 'aria-label': t('analysisTools.analysisTools') },
    ...TOOLS.map(([id]) => el('option', { value: id }, toolName(id))));
  list.selectedIndex = 0;
  const hint = el('p.small.muted.da-hint', { 'aria-live': 'polite' });
  const describe = () => { hint.textContent = TOOL_HINTS[list.value] ? t(TOOL_HINTS[list.value]) : ''; };
  list.addEventListener('change', describe);
  describe();
  const choose = (e) => {
    e?.preventDefault();
    if (!list.value) return;
    const id = list.value;
    modal.close();
    openAnalysisTool(ctx, id);
  };
  list.addEventListener('dblclick', choose);
  list.addEventListener('keydown', (e) => { if (e.key === 'Enter') choose(e); });
  const content = el('form.da-picker', { onsubmit: choose },
    el('span.field-label', {}, t('analysisTools.analysisTools')),
    list, hint,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('analysisTools.title'), content, initialFocus: list, onClose: () => ctx.grid?.focus?.() });
  return modal;
}

/**
 * The dialog of one tool. Each tool lists its fields (built by the helpers below) and a `run` that
 * reads them and returns a layout, or { error, field } naming the field at fault.
 */
export function openAnalysisTool(ctx, id) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const f = {};
  const { alert, refuse } = fieldAlert('da');
  const uid = fieldId('da');

  /* ---- Field builders ---- */
  const text = (key, label, value = '', extra = {}) => {
    const input = el('input.input', { type: 'text', 'aria-label': label, value, autocomplete: 'off', spellcheck: false, ...extra });
    f[key] = input;
    return el('label.field.da-field', {}, el('span.field-label', {}, label), input);
  };
  const range = (key, label, value = '') => text(key, label, value, { placeholder: t('analysisTools.rangePlaceholder') });
  const number = (key, label, value) => text(key, label, value == null || value === '' ? '' : numberShown(value), { inputmode: 'decimal' });
  const check = (key, label, checked = false) => {
    const box = el('input', { type: 'checkbox', checked });
    f[key] = box;
    return el('label.check', {}, box, el('span', {}, label));
  };
  /** A checkbox that switches a number field on, as Confidence Level and Kth Largest do. */
  const checkedNumber = (key, label, value, checked = false) => {
    const box = el('input', { type: 'checkbox', checked, 'aria-label': label });
    const input = el('input.input.da-narrow', { type: 'text', inputmode: 'decimal', value: numberShown(value), 'aria-label': t('analysisTools.fieldValue', { label }), disabled: !checked, autocomplete: 'off' });
    box.addEventListener('change', () => { input.disabled = !box.checked; });
    f[key] = box; f[`${key}Value`] = input;
    return el('div.da-inline', {}, el('label.check', {}, box, el('span', {}, label)), input);
  };
  const radios = (key, legend, options, chosen) => {
    const name = `${uid}-${key}`;
    const inputs = options.map(([value, label]) => {
      const input = el('input', { type: 'radio', name, value, checked: value === chosen });
      return [input, el('label.check', {}, input, el('span', {}, label))];
    });
    f[key] = { get value() { return inputs.find(([i]) => i.checked)?.[0].value; }, inputs: inputs.map(([i]) => i) };
    return el('fieldset.check-group.da-radios', {}, el('legend.field-label', {}, legend), ...inputs.map(([, l]) => l));
  };
  const select = (key, label, options) => {
    const node = el('select.select', { 'aria-label': label }, ...options.map(([value, text]) => el('option', { value }, text)));
    f[key] = node;
    return el('label.field.da-field', {}, el('span.field-label', {}, label), el('div.select-wrap', {}, node));
  };
  /** Grouped By with the labels checkbox, whose wording follows the grouping. */
  const grouping = () => {
    const group = radios('by', t('analysisTools.groupedBy'), [['columns', t('analysisTools.columns')], ['rows', t('analysisTools.rows')]], 'columns');
    const labels = check('labels', t('analysisTools.labelsFirstRow'));
    const words = labels.querySelector('span');
    for (const input of f.by.inputs) input.addEventListener('change', () => { words.textContent = f.by.value === 'rows' ? t('analysisTools.labelsFirstColumn') : t('analysisTools.labelsFirstRow'); });
    return [group, labels];
  };
  const alpha = () => number('alpha', t('analysisTools.alpha'), 0.05);

  /* ---- Readers ---- */
  const problem = (error, field) => ({ error, field });
  // A field is named by the key of its name in mid-sentence ("input range", "the damping factor").
  const resolve = (key, nameKey) => {
    const name = t(nameKey);
    const typed = f[key].value.trim();
    if (!typed) return problem(t('analysisTools.errors.enterRange', { name }), key);
    const found = ctx.resolveRange?.(typed) || wb.rangeFromText(sheetId, typed);
    if (!found) return problem(t('analysisTools.errors.rangeAsReference', { name }), key);
    if (wb.sheet(found.sheetId)?.kind === 'chart') return problem(cap(t('analysisTools.errors.rangeOnWorksheet', { name })), key);
    return found;
  };
  const num = (key, nameKey, { optional = false } = {}) => {
    // A trailing % names the unit a percentage field already asks in (95% is 95); numbers read in the regional format.
    const typed = f[key].value.trim().replace(/\s*%$/, '');
    if (typed === '') return optional ? null : problem(t('analysisTools.errors.enterNumber', { name: t(nameKey) }), key);
    const n = typedNumber(typed);
    return n != null ? n : problem(cap(t('analysisTools.errors.notNumber', { name: t(nameKey) })), key);
  };
  const failed = (v) => v && typeof v === 'object' && 'error' in v && !Array.isArray(v);
  const groupsOf = (key, nameKey, options = {}) => {
    const found = resolve(key, nameKey);
    if (failed(found)) return found;
    const out = readGroups(wb, found.sheetId, found.range, { by: options.by ?? f.by?.value ?? 'columns', labels: options.labels ?? f.labels?.checked, name: cap(t(nameKey)), ...options });
    if (out.error) return problem(out.error, key);
    return { ...out, found };
  };
  /** One variable: a single column or row. */
  const single = (key, nameKey, options = {}) => {
    const found = resolve(key, nameKey);
    if (failed(found)) return found;
    const { range: g } = found;
    const rowWise = g.r1 === g.r2 && g.c1 !== g.c2;
    if (!rowWise && g.c1 !== g.c2) return problem(cap(t('analysisTools.errors.singleColumnOrRow', { name: t(nameKey) })), key);
    const out = readGroups(wb, found.sheetId, g, { by: rowWise ? 'rows' : 'columns', labels: f.labels?.checked, name: cap(t(nameKey)), defaultLabel: options.defaultLabel, allowText: options.allowText });
    if (out.error) return problem(out.error, key);
    return { group: out.groups[0], found };
  };
  const withAlpha = () => {
    const a = num('alpha', 'analysisTools.names.alpha');
    if (failed(a)) return a;
    return a > 0 && a < 1 ? a : problem(t('analysisTools.errors.alphaRange'), 'alpha');
  };
  const percentOf = (key, nameKey) => {
    const v = num(key, nameKey);
    if (failed(v)) return v;
    return v > 0 && v < 100 ? v / 100 : problem(cap(t('analysisTools.errors.percentRange', { name: t(nameKey) })), key);
  };
  const wholeOf = (key, nameKey, min = 1) => {
    const v = num(key, nameKey);
    if (failed(v)) return v;
    return Number.isInteger(v) && v >= min ? v : problem(cap(t('analysisTools.errors.wholeNumber', { name: t(nameKey), min })), key);
  };
  /** Two variables for the two-sample tests. */
  const twoVariables = () => {
    const a = single('range1', 'analysisTools.names.variable1Range', { defaultLabel: () => 'Variable 1' });
    if (failed(a)) return a;
    const b = single('range2', 'analysisTools.names.variable2Range', { defaultLabel: () => 'Variable 2' });
    if (failed(b)) return b;
    return { g1: a.group, g2: b.group, inputs: [a.found, b.found] };
  };
  const twoSampleFields = (extra = []) => [range('range1', t('analysisTools.fields.variable1Range'), selectionText(ctx, 0)), range('range2', t('analysisTools.fields.variable2Range'), selectionText(ctx, 1)),
    number('difference', t('analysisTools.fields.difference'), 0), ...extra, check('labels', t('analysisTools.fields.labels')), alpha()];
  const tRun = (kind) => () => {
    const v = twoVariables(); if (failed(v)) return v;
    const difference = num('difference', 'analysisTools.names.difference', { optional: true }); if (failed(difference)) return difference;
    const a = withAlpha(); if (failed(a)) return a;
    return { layout: tTest(v.g1, v.g2, { kind, difference: difference ?? 0, alpha: a }), inputs: v.inputs };
  };

  /* ---- The tools ---- */
  const TOOLS_UI = {
    anova1: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), ...grouping(), alpha()],
      run: () => {
        const g = groupsOf('input', 'analysisTools.names.inputRange'); if (failed(g)) return g;
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: anovaSingleFactor(g.groups, { alpha: a }), inputs: [g.found] };
      },
    },
    anova2rep: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), number('rows', t('analysisTools.fields.rowsPerSample'), 2), alpha(),
        el('p.small.muted', {}, t('analysisTools.fields.includeLabels'))],
      run: () => {
        const found = resolve('input', 'analysisTools.names.inputRange'); if (failed(found)) return found;
        const n = wholeOf('rows', 'analysisTools.names.rowsPerSample', 2); if (failed(n)) return n;
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: anovaTwoFactorReplication(readBlock(wb, found.sheetId, found.range), { rowsPerSample: n, alpha: a }), inputs: [found], field: 'input' };
      },
    },
    anova2: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), check('labels', t('analysisTools.fields.labels')), alpha()],
      run: () => {
        const found = resolve('input', 'analysisTools.names.inputRange'); if (failed(found)) return found;
        const a = withAlpha(); if (failed(a)) return a;
        let block = readBlock(wb, found.sheetId, found.range);
        let rowLabels = [], colLabels = [];
        if (f.labels.checked) {
          colLabels = block[0].slice(1).map((v) => (v == null ? null : String(v)));
          rowLabels = block.slice(1).map((row) => (row[0] == null ? null : String(row[0])));
          block = block.slice(1).map((row) => row.slice(1));
        }
        if (block.some((row) => row.some((v) => typeof v !== 'number'))) return problem(t('analysisTools.errors.nonNumericOrBlank'), 'input');
        return { layout: anovaTwoFactor(block, { rowLabels: rowLabels.map((l, i) => l ?? `Row ${i + 1}`), colLabels: colLabels.map((l, j) => l ?? `Column ${j + 1}`), alpha: a }), inputs: [found], field: 'input' };
      },
    },
    correlation: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), ...grouping()],
      run: () => { const g = groupsOf('input', 'analysisTools.names.inputRange'); if (failed(g)) return g; return { layout: correlation(g.groups), inputs: [g.found], field: 'input' }; },
    },
    covariance: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), ...grouping()],
      run: () => { const g = groupsOf('input', 'analysisTools.names.inputRange'); if (failed(g)) return g; return { layout: covariance(g.groups), inputs: [g.found], field: 'input' }; },
    },
    descriptive: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), ...grouping(),
        el('div.da-options', {}, check('summary', t('analysisTools.fields.summary'), true), checkedNumber('confidence', t('analysisTools.fields.confidenceMean'), 95),
          checkedNumber('largest', t('analysisTools.fields.kthLargest'), 1), checkedNumber('smallest', t('analysisTools.fields.kthSmallest'), 1))],
      run: () => {
        const g = groupsOf('input', 'analysisTools.names.inputRange'); if (failed(g)) return g;
        const opt = { summary: f.summary.checked };
        if (f.confidence.checked) { const c = percentOf('confidenceValue', 'analysisTools.names.confidence'); if (failed(c)) return c; opt.confidence = c; }
        if (f.largest.checked) { const k = wholeOf('largestValue', 'analysisTools.names.kthLargest'); if (failed(k)) return k; opt.kthLargest = k; }
        if (f.smallest.checked) { const k = wholeOf('smallestValue', 'analysisTools.names.kthSmallest'); if (failed(k)) return k; opt.kthSmallest = k; }
        return { layout: descriptiveStatistics(g.groups, opt), inputs: [g.found], field: 'summary' };
      },
    },
    smoothing: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), number('damping', t('analysisTools.fields.damping'), 0.3), check('labels', t('analysisTools.fields.labels')),
        el('div.da-options', {}, check('chart', t('analysisTools.fields.chartOutput')), check('errors', t('analysisTools.fields.standardErrors')))],
      run: () => {
        const s = single('input', 'analysisTools.names.inputRange'); if (failed(s)) return s;
        const d = num('damping', 'analysisTools.names.damping'); if (failed(d)) return d;
        if (!(d >= 0 && d <= 1)) return problem(t('analysisTools.errors.dampingRange'), 'damping');
        return { layout: exponentialSmoothing(s.group, { damping: d, labels: f.labels.checked, chart: f.chart.checked, standardErrors: f.errors.checked }), inputs: [s.found], field: 'input' };
      },
    },
    ftest: {
      fields: () => [range('range1', t('analysisTools.fields.variable1Range'), selectionText(ctx, 0)), range('range2', t('analysisTools.fields.variable2Range'), selectionText(ctx, 1)), check('labels', t('analysisTools.fields.labels')), alpha()],
      run: () => {
        const v = twoVariables(); if (failed(v)) return v;
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: fTest(v.g1, v.g2, { alpha: a }), inputs: v.inputs, field: 'range1' };
      },
    },
    fourier: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), check('labels', t('analysisTools.labelsFirstRow')), check('inverse', t('analysisTools.fields.inverse'))],
      run: () => {
        const s = single('input', 'analysisTools.names.inputRange', { allowText: true }); if (failed(s)) return s;
        return { layout: fourier(s.group, { inverse: f.inverse.checked, labels: f.labels.checked }), inputs: [s.found], field: 'input' };
      },
    },
    histogram: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), range('bins', t('analysisTools.fields.binRange')), check('labels', t('analysisTools.fields.labels')),
        el('div.da-options', {}, check('pareto', t('analysisTools.fields.pareto')), check('cumulative', t('analysisTools.fields.cumulative')), check('chart', t('analysisTools.fields.chartOutput')))],
      run: () => {
        const found = resolve('input', 'analysisTools.names.inputRange'); if (failed(found)) return found;
        const data = readGroups(wb, found.sheetId, found.range, { by: 'columns', labels: f.labels.checked, name: t('analysisTools.fields.inputRange') });
        if (data.error) return problem(data.error, 'input');
        let bins = null, binLabel = null;
        const inputs = [found];
        if (f.bins.value.trim()) {
          const b = single('bins', 'analysisTools.names.binRange'); if (failed(b)) return b;
          bins = b.group.values; inputs.push(b.found);
          if (f.labels.checked) binLabel = b.group.label;
        }
        const group = { label: data.groups[0]?.label, values: data.groups.flatMap((g) => g.values) };
        return { layout: histogram(group, { bins, binLabel, pareto: f.pareto.checked, cumulative: f.cumulative.checked, chart: f.chart.checked }), inputs, field: 'input' };
      },
    },
    moving: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), check('labels', t('analysisTools.labelsFirstRow')), number('interval', t('analysisTools.fields.interval'), 3),
        el('div.da-options', {}, check('chart', t('analysisTools.fields.chartOutput')), check('errors', t('analysisTools.fields.standardErrors')))],
      run: () => {
        const s = single('input', 'analysisTools.names.inputRange'); if (failed(s)) return s;
        const k = wholeOf('interval', 'analysisTools.names.interval', 2); if (failed(k)) return k;
        return { layout: movingAverage(s.group, { interval: k, labels: f.labels.checked, chart: f.chart.checked, standardErrors: f.errors.checked }), inputs: [s.found], field: 'input' };
      },
    },
    random: {
      fields: () => {
        const dist = select('dist', t('analysisTools.fields.distribution'), [['uniform', t('analysisTools.dist.uniform')], ['normal', t('analysisTools.dist.normal')], ['bernoulli', t('analysisTools.dist.bernoulli')], ['binomial', t('analysisTools.dist.binomial')],
          ['poisson', t('analysisTools.dist.poisson')], ['patterned', t('analysisTools.dist.patterned')], ['discrete', t('analysisTools.dist.discrete')]]);
        const params = {
          uniform: [number('from', t('analysisTools.fields.between'), 0), number('to', t('analysisTools.fields.and'), 1)],
          normal: [number('mean', t('analysisTools.fields.mean'), 0), number('sd', t('analysisTools.fields.sd'), 1)],
          bernoulli: [number('p', t('analysisTools.fields.p'), 0.5)],
          binomial: [number('bp', t('analysisTools.fields.p'), 0.5), number('trials', t('analysisTools.fields.trials'), 10)],
          poisson: [number('lambda', t('analysisTools.fields.lambda'), 1)],
          patterned: [number('pfrom', t('analysisTools.fields.from'), 1), number('pto', t('analysisTools.fields.to'), 10), number('step', t('analysisTools.fields.step'), 1),
            number('each', t('analysisTools.fields.repeatEach'), 1), number('times', t('analysisTools.fields.repeatSequence'), 1)],
          discrete: [range('pairs', t('analysisTools.fields.pairsRange'))],
        };
        const groups = Object.entries(params).map(([key, nodes]) => el('fieldset.da-params', { dataset: { dist: key } }, el('legend.field-label', {}, t('analysisTools.fields.parameters')), ...nodes));
        const sync = () => { for (const g of groups) g.hidden = g.dataset.dist !== f.dist.value; f.count.disabled = f.dist.value === 'patterned'; };
        f.dist.addEventListener('change', sync);
        const out = [number('vars', t('analysisTools.fields.variables'), 1), number('count', t('analysisTools.fields.randomCount'), 10), dist, ...groups, number('seed', t('analysisTools.fields.seed'), '')];
        sync();
        return out;
      },
      run: () => {
        const vars = wholeOf('vars', 'analysisTools.names.variables'); if (failed(vars)) return vars;
        const kind = f.dist.value;
        let count = 1;
        if (kind !== 'patterned') { count = wholeOf('count', 'analysisTools.names.randomCount'); if (failed(count)) return count; }
        const seed = num('seed', 'analysisTools.names.seed', { optional: true }); if (failed(seed)) return seed;
        const read = (pairs) => {
          const out = {};
          for (const [key, name, nameKey] of pairs) { const v = num(key, nameKey); if (failed(v)) return v; out[name] = v; }
          return out;
        };
        let params;
        if (kind === 'uniform') params = read([['from', 'from', 'analysisTools.names.lowerBound'], ['to', 'to', 'analysisTools.names.upperBound']]);
        else if (kind === 'normal') params = read([['mean', 'mean', 'analysisTools.names.mean'], ['sd', 'sd', 'analysisTools.names.sd']]);
        else if (kind === 'bernoulli') params = read([['p', 'p', 'analysisTools.names.p']]);
        else if (kind === 'binomial') params = read([['bp', 'p', 'analysisTools.names.p'], ['trials', 'trials', 'analysisTools.names.trials']]);
        else if (kind === 'poisson') params = read([['lambda', 'lambda', 'analysisTools.names.lambda']]);
        else if (kind === 'patterned') params = read([['pfrom', 'from', 'analysisTools.names.firstNumber'], ['pto', 'to', 'analysisTools.names.lastNumber'], ['step', 'step', 'analysisTools.names.step'], ['each', 'repeatEach', 'analysisTools.names.repeatEach'], ['times', 'repeatSequence', 'analysisTools.names.repeatSequence']]);
        else {
          const found = resolve('pairs', 'analysisTools.names.pairsRange'); if (failed(found)) return found;
          const block = readBlock(wb, found.sheetId, found.range);
          if (block[0]?.length !== 2) return problem(t('analysisTools.errors.pairsColumns'), 'pairs');
          params = { values: block.map((row) => row[0]), probabilities: block.map((row) => row[1]) };
        }
        if (failed(params)) return params;
        return { layout: randomNumbers({ variables: vars, count, distribution: kind, seed, params }), inputs: [], field: 'vars' };
      },
    },
    rank: {
      fields: () => [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), ...grouping()],
      run: () => { const g = groupsOf('input', 'analysisTools.names.inputRange'); if (failed(g)) return g; return { layout: rankAndPercentile(g.groups), inputs: [g.found], field: 'input' }; },
    },
    regression: {
      fields: () => [range('y', t('analysisTools.fields.inputYRange'), selectionText(ctx)), range('x', t('analysisTools.fields.inputXRange')),
        el('div.da-options', {}, check('labels', t('analysisTools.fields.labels')), check('zero', t('analysisTools.fields.constantZero')), checkedNumber('confidence', t('analysisTools.fields.confidence'), 95)),
        el('fieldset.da-group', {}, el('legend.field-label', {}, t('analysisTools.fields.residuals')),
          check('residuals', t('analysisTools.fields.residuals')), check('standardized', t('analysisTools.fields.standardized')), check('residualPlots', t('analysisTools.fields.residualPlots')), check('lineFit', t('analysisTools.fields.lineFit'))),
        el('fieldset.da-group', {}, el('legend.field-label', {}, t('analysisTools.fields.normalProbability')), check('normal', t('analysisTools.fields.normalPlots')))],
      run: () => {
        const yIn = single('y', 'analysisTools.names.inputYRange', { defaultLabel: () => 'Y' }); if (failed(yIn)) return yIn;
        const xFound = resolve('x', 'analysisTools.names.inputXRange'); if (failed(xFound)) return xFound;
        const xIn = readGroups(wb, xFound.sheetId, xFound.range, { by: 'columns', labels: f.labels.checked, name: t('analysisTools.fields.inputXRange'), defaultLabel: () => null });
        if (xIn.error) return problem(xIn.error, 'x');
        if (xIn.groups[0].values.length !== yIn.group.values.length) return problem(t('coreAnalysisTools.errors.regressionSameRows'), 'x');
        let confidence = 0.95;
        if (f.confidence.checked) { confidence = percentOf('confidenceValue', 'analysisTools.names.confidence'); if (failed(confidence)) return confidence; }
        const many = xIn.groups.length > 1;
        const layout = regression(yIn.group.values, xIn.groups.map((g) => g.values), {
          confidence, constantZero: f.zero.checked, residuals: f.residuals.checked, standardized: f.standardized.checked,
          residualPlots: f.residualPlots.checked, lineFitPlots: f.lineFit.checked, normalPlot: f.normal.checked,
          yLabel: f.labels.checked ? yIn.group.label : 'Y',
          xLabels: xIn.groups.map((g, j) => (f.labels.checked && g.label ? g.label : many ? `X Variable ${j + 1}` : 'X Variable')),
          yRef: yIn.group.ref, xRefs: xIn.groups.map((g) => g.ref),
        });
        return { layout, inputs: [yIn.found, xFound], field: 'y' };
      },
    },
    sampling: {
      fields: () => {
        const method = radios('method', t('analysisTools.fields.samplingMethod'), [['periodic', t('analysisTools.fields.periodic')], ['random', t('analysisTools.fields.random')]], 'periodic');
        return [range('input', t('analysisTools.fields.inputRange'), selectionText(ctx)), check('labels', t('analysisTools.fields.labels')), method,
          number('period', t('analysisTools.fields.period'), 2), number('count', t('analysisTools.fields.samples'), 10), number('seed', t('analysisTools.fields.seed'), '')];
      },
      run: () => {
        const g = groupsOf('input', 'analysisTools.names.inputRange', { by: 'columns' }); if (failed(g)) return g;
        const values = g.groups.flatMap((x) => x.values);
        const method = f.method.value;
        const opt = { method, label: f.labels.checked && g.groups.length === 1 ? g.groups[0].label : null };
        if (method === 'periodic') { const p = wholeOf('period', 'analysisTools.names.period'); if (failed(p)) return p; opt.period = p; } else {
          const n = wholeOf('count', 'analysisTools.names.samples'); if (failed(n)) return n; opt.count = n;
          const seed = num('seed', 'analysisTools.names.seed', { optional: true }); if (failed(seed)) return seed; opt.seed = seed;
        }
        return { layout: sampling(values, opt), inputs: [g.found], field: method === 'periodic' ? 'period' : 'count' };
      },
    },
    tpaired: { fields: () => twoSampleFields(), run: tRun('paired') },
    tequal: { fields: () => twoSampleFields(), run: tRun('equal') },
    tunequal: { fields: () => twoSampleFields(), run: tRun('unequal') },
    ztest: {
      fields: () => twoSampleFields([number('var1', t('analysisTools.fields.variance1'), ''), number('var2', t('analysisTools.fields.variance2'), '')]),
      run: () => {
        const v = twoVariables(); if (failed(v)) return v;
        const difference = num('difference', 'analysisTools.names.difference', { optional: true }); if (failed(difference)) return difference;
        const v1 = num('var1', 'analysisTools.names.variance1'); if (failed(v1)) return v1;
        if (!(v1 > 0)) return problem(t('analysisTools.errors.knownVariance'), 'var1');
        const v2 = num('var2', 'analysisTools.names.variance2'); if (failed(v2)) return v2;
        if (!(v2 > 0)) return problem(t('analysisTools.errors.knownVariance'), 'var2');
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: zTest(v.g1, v.g2, { difference: difference ?? 0, variance1: v1, variance2: v2, alpha: a }), inputs: v.inputs, field: 'range1' };
      },
    },
  };

  const tool = TOOLS_UI[id];
  if (!tool) return null;
  const fields = tool.fields();

  /* ---- Output options ---- */
  const outputs = radios('output', t('analysisTools.output.options'), [['range', t('analysisTools.output.range')], ['sheet', t('analysisTools.output.sheet')], ['book', t('analysisTools.output.book')]], 'sheet');
  const outRange = el('input.input', { type: 'text', 'aria-label': t('analysisTools.output.range'), autocomplete: 'off', spellcheck: false, placeholder: t('analysisTools.output.rangePlaceholder') });
  const sheetName = el('input.input', { type: 'text', 'aria-label': t('analysisTools.output.sheetName'), autocomplete: 'off', placeholder: t('analysisTools.output.sheetNamePlaceholder'), maxLength: 31 });
  const bookName = el('input.input', { type: 'text', 'aria-label': t('analysisTools.output.bookName'), autocomplete: 'off', value: toolName(id).replace(/[:/\\]/g, ' -') });
  f.outRange = outRange; f.sheetName = sheetName; f.bookName = bookName;
  const syncOutput = () => {
    outRange.disabled = f.output.value !== 'range';
    sheetName.disabled = f.output.value !== 'sheet';
    bookName.disabled = f.output.value !== 'book';
  };
  for (const input of f.output.inputs) input.addEventListener('change', syncOutput);
  const [rangeLabel, sheetLabel, bookLabel] = outputs.querySelectorAll('label.check');
  outputs.replaceChildren(outputs.querySelector('legend'),
    el('div.da-output-row', {}, rangeLabel, outRange), el('div.da-output-row', {}, sheetLabel, sheetName), el('div.da-output-row', {}, bookLabel, bookName));
  outputs.classList.add('da-output');
  syncOutput();

  const overlaps = (a, b) => a.sheetId === b.sheetId && a.range.r1 <= b.range.r2 && b.range.r1 <= a.range.r2 && a.range.c1 <= b.range.c2 && b.range.c1 <= a.range.c2;

  let busy = false;
  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    // A tool that throws (data beyond what it can work through) says so in the dialog rather than doing nothing.
    try { await perform(); } catch (err) { refuse(null, t('analysisTools.errors.couldNotFinish', { tool: toolName(id), message: err?.message || t('analysisTools.errors.unknown') })); }
  };
  const perform = async () => {
    const res = tool.run();
    if (failed(res)) return refuse(res.field ? (f[res.field]?.inputs?.[0] || f[res.field]) : null, res.error);
    const { layout } = res;
    if (layout.error) return refuse(res.field ? f[res.field] : null, layout.error);
    const mode = f.output.value;
    if (mode === 'range') {
      const target = resolve('outRange', 'analysisTools.names.outputRange');
      if (failed(target)) return refuse(outRange, target.error);
      const { rows, cols } = layoutSize(layout);
      const box = { sheetId: target.sheetId, range: { r1: target.range.r1, c1: target.range.c1, r2: target.range.r1 + rows - 1, c2: target.range.c1 + cols - 1 } };
      if (res.inputs.some((input) => overlaps(input, box))) {
        const ok = await confirmDialog({ title: t('analysisTools.confirm.overInputTitle'), message: t('analysisTools.confirm.overInputMessage'), confirmLabel: t('analysisTools.confirm.writeOver'), danger: true });
        if (!ok) return;
      } else if (outputOccupied(wb, target.sheetId, layout, target.range.r1, target.range.c1)) {
        const ok = await confirmDialog({ title: t('analysisTools.confirm.replaceTitle'), message: t('analysisTools.confirm.replaceMessage', { rows, cols }), confirmLabel: t('common.replace'), danger: true });
        if (!ok) return;
      }
      const out = writeAnalysisOutput(wb, layout, { kind: 'range', sheetId: target.sheetId, r: target.range.r1, c: target.range.c1 });
      if (out.error) return refuse(outRange, out.error);
      modal.close();
      if (out.sheetId !== ctx.sheetId()) wb.setActiveSheet(out.sheetId);
      ctx.grid?.setSelection?.(S.fromRange(out.range), { scroll: true });
      toast(t('analysisTools.toast.writtenTo', { tool: toolName(id), ref: `${quoteSheet(wb.sheet(out.sheetId).name)}!${colName(out.range.c1)}${out.range.r1 + 1}` }), { icon: 'check' });
      return;
    }
    if (mode === 'sheet') {
      const name = sheetName.value.trim();
      const bad = name && wb.validateSheetName(name);
      if (bad) return refuse(sheetName, bad);
      const out = writeAnalysisOutput(wb, layout, { kind: 'sheet', name });
      if (out.error) return refuse(sheetName, out.error);
      modal.close();
      wb.setActiveSheet(out.sheetId);
      toast(t('analysisTools.toast.writtenToSheet', { tool: toolName(id) }), { icon: 'check' });
      return;
    }
    const clean = P.sanitizeName(bookName.value).replace(/\.xlsx$/i, '');
    if (!clean) return refuse(bookName, t('analysisTools.errors.enterBookName'));
    const book = analysisWorkbook(wb, layout, 'Sheet1');
    if (!book) return refuse(null, t('analysisTools.errors.couldNotMakeBook'));
    busy = true;
    try {
      const fileName = await P.uniqueName(clean);
      const path = `${P.FOLDER}/${fileName}`;
      const written = await P.writeFile(path, await workbookToXlsx(book), { dedupe: true });
      const savedName = written?.name || P.displayName(written?.path || path);
      const saved = P.canonicalPath(`${P.FOLDER}/${savedName}`, written);
      modal.close();
      toast(t('analysisTools.toast.savedAs', { tool: toolName(id), name: stripExtension(savedName) }), { icon: 'check', action: { label: t('common.open'), onClick: () => ctx.run?.('openFile', saved) } });
    } catch (err) {
      refuse(null, t('analysisTools.errors.couldNotSaveBook', { message: err?.message || t('analysisTools.errors.unknown') }));
    } finally {
      busy = false;
    }
  };

  const content = el('form.da-dialog', { onsubmit: submit },
    el('p.small.muted', {}, t(TOOL_HINTS[id])),
    el('div.da-fields', {}, ...fields),
    outputs,
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => { modal.close(); openDataAnalysis(ctx); } }, t('common.back')),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const first = Object.values(f).find((node) => node instanceof HTMLInputElement && node.type === 'text' && !node.disabled);
  const modal = openModal({ title: toolName(id), content, initialFocus: first, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
