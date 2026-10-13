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
import { quoteSheet } from '../core/refs.js';
import { workbookToXlsx, stripExtension } from '../core/io.js';
import {
  TOOLS, readGroups, readBlock, anovaSingleFactor, anovaTwoFactorReplication, anovaTwoFactor, correlation, covariance,
  descriptiveStatistics, exponentialSmoothing, fTest, fourier, histogram, movingAverage, randomNumbers, rankAndPercentile,
  regression, sampling, tTest, zTest, writeAnalysisOutput, analysisWorkbook, outputOccupied, layoutSize,
} from '../core/analysis-tools.js';

const TOOL_HINTS = {
  anova1: 'Tests whether the means of several groups differ.',
  anova2rep: 'Two factors, with several observations for each combination.',
  anova2: 'Two factors, with one observation for each combination.',
  correlation: 'Pearson correlation between every pair of variables.',
  covariance: 'Population covariance between every pair of variables.',
  descriptive: 'Mean, spread, shape and size of each variable.',
  smoothing: 'Forecasts each point from the last forecast and the last actual value.',
  ftest: 'Compares the variances of two samples.',
  fourier: 'Discrete Fourier transform of 2, 4, 8, … values.',
  histogram: 'Counts how many values fall in each bin.',
  moving: 'Forecasts each point as the average of the points before it.',
  random: 'Fills a range with numbers drawn from a distribution.',
  rank: 'The rank and percentile of every value.',
  regression: 'Least-squares fit of Y on one or more X variables.',
  sampling: 'Picks values from a range, periodically or at random.',
  tpaired: 'Compares the means of two matched samples.',
  tequal: 'Compares two means, assuming the same variance.',
  tunequal: 'Compares two means without assuming the same variance.',
  ztest: 'Compares two means when the variances are known.',
};

const toolName = (id) => TOOLS.find(([key]) => key === id)?.[1] || id;

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
  const list = el('select.select.da-list', { size: 12, 'aria-label': 'Analysis tools' },
    ...TOOLS.map(([id, name]) => el('option', { value: id }, name)));
  list.selectedIndex = 0;
  const hint = el('p.small.muted.da-hint', { 'aria-live': 'polite' });
  const describe = () => { hint.textContent = TOOL_HINTS[list.value] || ''; };
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
    el('span.field-label', {}, 'Analysis tools'),
    list, hint,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Data Analysis', content, initialFocus: list, onClose: () => ctx.grid?.focus?.() });
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
  const range = (key, label, value = '') => text(key, label, value, { placeholder: 'e.g. $A$1:$A$20' });
  const number = (key, label, value) => text(key, label, value == null ? '' : String(value), { inputmode: 'decimal' });
  const check = (key, label, checked = false) => {
    const box = el('input', { type: 'checkbox', checked });
    f[key] = box;
    return el('label.check', {}, box, el('span', {}, label));
  };
  /** A checkbox that switches a number field on, as Confidence Level and Kth Largest do. */
  const checkedNumber = (key, label, value, checked = false) => {
    const box = el('input', { type: 'checkbox', checked, 'aria-label': label });
    const input = el('input.input.da-narrow', { type: 'text', inputmode: 'decimal', value: String(value), 'aria-label': `${label} value`, disabled: !checked, autocomplete: 'off' });
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
    const group = radios('by', 'Grouped by', [['columns', 'Columns'], ['rows', 'Rows']], 'columns');
    const labels = check('labels', 'Labels in first row');
    const words = labels.querySelector('span');
    for (const input of f.by.inputs) input.addEventListener('change', () => { words.textContent = f.by.value === 'rows' ? 'Labels in first column' : 'Labels in first row'; });
    return [group, labels];
  };
  const alpha = () => number('alpha', 'Alpha', 0.05);

  /* ---- Readers ---- */
  const problem = (error, field) => ({ error, field });
  const resolve = (key, label) => {
    const t = f[key].value.trim();
    if (!t) return problem(`Enter the ${label}.`, key);
    const found = ctx.resolveRange?.(t) || wb.rangeFromText(sheetId, t);
    if (!found) return problem(`Enter the ${label} as a reference such as $A$1:$B$20, or a defined name.`, key);
    if (wb.sheet(found.sheetId)?.kind === 'chart') return problem(`The ${label} must be on a worksheet.`, key);
    return found;
  };
  const num = (key, label, { optional = false } = {}) => {
    const t = f[key].value.trim().replace(/%$/, '');
    if (t === '') return optional ? null : problem(`Enter ${label}.`, key);
    const n = Number(t);
    return Number.isFinite(n) ? n : problem(`${label[0].toUpperCase()}${label.slice(1)} must be a number.`, key);
  };
  const failed = (v) => v && typeof v === 'object' && 'error' in v && !Array.isArray(v);
  const groupsOf = (key, label, options = {}) => {
    const found = resolve(key, label);
    if (failed(found)) return found;
    const out = readGroups(wb, found.sheetId, found.range, { by: options.by ?? f.by?.value ?? 'columns', labels: options.labels ?? f.labels?.checked, name: label[0].toUpperCase() + label.slice(1), ...options });
    if (out.error) return problem(out.error, key);
    return { ...out, found };
  };
  /** One variable: a single column or row. */
  const single = (key, label, options = {}) => {
    const found = resolve(key, label);
    if (failed(found)) return found;
    const { range: g } = found;
    const rowWise = g.r1 === g.r2 && g.c1 !== g.c2;
    if (!rowWise && g.c1 !== g.c2) return problem(`The ${label} must be a single column or row.`, key);
    const out = readGroups(wb, found.sheetId, g, { by: rowWise ? 'rows' : 'columns', labels: f.labels?.checked, name: label[0].toUpperCase() + label.slice(1), defaultLabel: options.defaultLabel, allowText: options.allowText });
    if (out.error) return problem(out.error, key);
    return { group: out.groups[0], found };
  };
  const withAlpha = () => {
    const a = num('alpha', 'alpha');
    if (failed(a)) return a;
    return a > 0 && a < 1 ? a : problem('Alpha must be between 0 and 1, such as 0.05.', 'alpha');
  };
  const percentOf = (key, label) => {
    const v = num(key, label);
    if (failed(v)) return v;
    return v > 0 && v < 100 ? v / 100 : problem(`${label[0].toUpperCase()}${label.slice(1)} must be between 0 and 100.`, key);
  };
  const wholeOf = (key, label, min = 1) => {
    const v = num(key, label);
    if (failed(v)) return v;
    return Number.isInteger(v) && v >= min ? v : problem(`${label[0].toUpperCase()}${label.slice(1)} must be a whole number of ${min} or more.`, key);
  };
  /** Two variables for the two-sample tests. */
  const twoVariables = () => {
    const a = single('range1', 'variable 1 range', { defaultLabel: () => 'Variable 1' });
    if (failed(a)) return a;
    const b = single('range2', 'variable 2 range', { defaultLabel: () => 'Variable 2' });
    if (failed(b)) return b;
    return { g1: a.group, g2: b.group, inputs: [a.found, b.found] };
  };
  const twoSampleFields = (extra = []) => [range('range1', 'Variable 1 range', selectionText(ctx, 0)), range('range2', 'Variable 2 range', selectionText(ctx, 1)),
    number('difference', 'Hypothesized mean difference', 0), ...extra, check('labels', 'Labels'), alpha()];
  const tRun = (kind) => () => {
    const v = twoVariables(); if (failed(v)) return v;
    const difference = num('difference', 'the hypothesized mean difference', { optional: true }); if (failed(difference)) return difference;
    const a = withAlpha(); if (failed(a)) return a;
    return { layout: tTest(v.g1, v.g2, { kind, difference: difference ?? 0, alpha: a }), inputs: v.inputs };
  };

  /* ---- The tools ---- */
  const TOOLS_UI = {
    anova1: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), ...grouping(), alpha()],
      run: () => {
        const g = groupsOf('input', 'input range'); if (failed(g)) return g;
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: anovaSingleFactor(g.groups, { alpha: a }), inputs: [g.found] };
      },
    },
    anova2rep: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), number('rows', 'Rows per sample', 2), alpha(),
        el('p.small.muted', {}, 'Include the labels: the first row names the columns, the first column names each sample.')],
      run: () => {
        const found = resolve('input', 'input range'); if (failed(found)) return found;
        const n = wholeOf('rows', 'rows per sample', 2); if (failed(n)) return n;
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: anovaTwoFactorReplication(readBlock(wb, found.sheetId, found.range), { rowsPerSample: n, alpha: a }), inputs: [found], field: 'input' };
      },
    },
    anova2: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), check('labels', 'Labels'), alpha()],
      run: () => {
        const found = resolve('input', 'input range'); if (failed(found)) return found;
        const a = withAlpha(); if (failed(a)) return a;
        let block = readBlock(wb, found.sheetId, found.range);
        let rowLabels = [], colLabels = [];
        if (f.labels.checked) {
          colLabels = block[0].slice(1).map((v) => (v == null ? null : String(v)));
          rowLabels = block.slice(1).map((row) => (row[0] == null ? null : String(row[0])));
          block = block.slice(1).map((row) => row.slice(1));
        }
        if (block.some((row) => row.some((v) => typeof v !== 'number'))) return problem('Input range contains non-numeric data or blank cells.', 'input');
        return { layout: anovaTwoFactor(block, { rowLabels: rowLabels.map((l, i) => l ?? `Row ${i + 1}`), colLabels: colLabels.map((l, j) => l ?? `Column ${j + 1}`), alpha: a }), inputs: [found], field: 'input' };
      },
    },
    correlation: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), ...grouping()],
      run: () => { const g = groupsOf('input', 'input range'); if (failed(g)) return g; return { layout: correlation(g.groups), inputs: [g.found], field: 'input' }; },
    },
    covariance: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), ...grouping()],
      run: () => { const g = groupsOf('input', 'input range'); if (failed(g)) return g; return { layout: covariance(g.groups), inputs: [g.found], field: 'input' }; },
    },
    descriptive: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), ...grouping(),
        el('div.da-options', {}, check('summary', 'Summary statistics', true), checkedNumber('confidence', 'Confidence level for mean (%)', 95),
          checkedNumber('largest', 'Kth largest', 1), checkedNumber('smallest', 'Kth smallest', 1))],
      run: () => {
        const g = groupsOf('input', 'input range'); if (failed(g)) return g;
        const opt = { summary: f.summary.checked };
        if (f.confidence.checked) { const c = percentOf('confidenceValue', 'the confidence level'); if (failed(c)) return c; opt.confidence = c; }
        if (f.largest.checked) { const k = wholeOf('largestValue', 'kth largest'); if (failed(k)) return k; opt.kthLargest = k; }
        if (f.smallest.checked) { const k = wholeOf('smallestValue', 'kth smallest'); if (failed(k)) return k; opt.kthSmallest = k; }
        return { layout: descriptiveStatistics(g.groups, opt), inputs: [g.found], field: 'summary' };
      },
    },
    smoothing: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), number('damping', 'Damping factor', 0.3), check('labels', 'Labels'),
        el('div.da-options', {}, check('chart', 'Chart output'), check('errors', 'Standard errors'))],
      run: () => {
        const s = single('input', 'input range'); if (failed(s)) return s;
        const d = num('damping', 'the damping factor'); if (failed(d)) return d;
        if (!(d >= 0 && d <= 1)) return problem('The damping factor must be between 0 and 1.', 'damping');
        return { layout: exponentialSmoothing(s.group, { damping: d, labels: f.labels.checked, chart: f.chart.checked, standardErrors: f.errors.checked }), inputs: [s.found], field: 'input' };
      },
    },
    ftest: {
      fields: () => [range('range1', 'Variable 1 range', selectionText(ctx, 0)), range('range2', 'Variable 2 range', selectionText(ctx, 1)), check('labels', 'Labels'), alpha()],
      run: () => {
        const v = twoVariables(); if (failed(v)) return v;
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: fTest(v.g1, v.g2, { alpha: a }), inputs: v.inputs, field: 'range1' };
      },
    },
    fourier: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), check('labels', 'Labels in first row'), check('inverse', 'Inverse')],
      run: () => {
        const s = single('input', 'input range', { allowText: true }); if (failed(s)) return s;
        return { layout: fourier(s.group, { inverse: f.inverse.checked, labels: f.labels.checked }), inputs: [s.found], field: 'input' };
      },
    },
    histogram: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), range('bins', 'Bin range (optional)'), check('labels', 'Labels'),
        el('div.da-options', {}, check('pareto', 'Pareto (sorted histogram)'), check('cumulative', 'Cumulative percentage'), check('chart', 'Chart output'))],
      run: () => {
        const found = resolve('input', 'input range'); if (failed(found)) return found;
        const data = readGroups(wb, found.sheetId, found.range, { by: 'columns', labels: f.labels.checked, name: 'Input range' });
        if (data.error) return problem(data.error, 'input');
        let bins = null, binLabel = null;
        const inputs = [found];
        if (f.bins.value.trim()) {
          const b = single('bins', 'bin range'); if (failed(b)) return b;
          bins = b.group.values; inputs.push(b.found);
          if (f.labels.checked) binLabel = b.group.label;
        }
        const group = { label: data.groups[0]?.label, values: data.groups.flatMap((g) => g.values) };
        return { layout: histogram(group, { bins, binLabel, pareto: f.pareto.checked, cumulative: f.cumulative.checked, chart: f.chart.checked }), inputs, field: 'input' };
      },
    },
    moving: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), check('labels', 'Labels in first row'), number('interval', 'Interval', 3),
        el('div.da-options', {}, check('chart', 'Chart output'), check('errors', 'Standard errors'))],
      run: () => {
        const s = single('input', 'input range'); if (failed(s)) return s;
        const k = wholeOf('interval', 'the interval', 2); if (failed(k)) return k;
        return { layout: movingAverage(s.group, { interval: k, labels: f.labels.checked, chart: f.chart.checked, standardErrors: f.errors.checked }), inputs: [s.found], field: 'input' };
      },
    },
    random: {
      fields: () => {
        const dist = select('dist', 'Distribution', [['uniform', 'Uniform'], ['normal', 'Normal'], ['bernoulli', 'Bernoulli'], ['binomial', 'Binomial'],
          ['poisson', 'Poisson'], ['patterned', 'Patterned'], ['discrete', 'Discrete']]);
        const params = {
          uniform: [number('from', 'Between', 0), number('to', 'And', 1)],
          normal: [number('mean', 'Mean', 0), number('sd', 'Standard deviation', 1)],
          bernoulli: [number('p', 'p value', 0.5)],
          binomial: [number('bp', 'p value', 0.5), number('trials', 'Number of trials', 10)],
          poisson: [number('lambda', 'Lambda', 1)],
          patterned: [number('pfrom', 'From', 1), number('pto', 'To', 10), number('step', 'In steps of', 1),
            number('each', 'Repeating each number', 1), number('times', 'Repeating the sequence', 1)],
          discrete: [range('pairs', 'Value and probability input range')],
        };
        const groups = Object.entries(params).map(([key, nodes]) => el('fieldset.da-params', { dataset: { dist: key } }, el('legend.field-label', {}, 'Parameters'), ...nodes));
        const sync = () => { for (const g of groups) g.hidden = g.dataset.dist !== f.dist.value; f.count.disabled = f.dist.value === 'patterned'; };
        f.dist.addEventListener('change', sync);
        const out = [number('vars', 'Number of variables', 1), number('count', 'Number of random numbers', 10), dist, ...groups, number('seed', 'Random seed (optional)', '')];
        sync();
        return out;
      },
      run: () => {
        const vars = wholeOf('vars', 'the number of variables'); if (failed(vars)) return vars;
        const kind = f.dist.value;
        let count = 1;
        if (kind !== 'patterned') { count = wholeOf('count', 'the number of random numbers'); if (failed(count)) return count; }
        const seed = num('seed', 'the random seed', { optional: true }); if (failed(seed)) return seed;
        const read = (pairs) => {
          const out = {};
          for (const [key, name, label] of pairs) { const v = num(key, label); if (failed(v)) return v; out[name] = v; }
          return out;
        };
        let params;
        if (kind === 'uniform') params = read([['from', 'from', 'the lower bound'], ['to', 'to', 'the upper bound']]);
        else if (kind === 'normal') params = read([['mean', 'mean', 'the mean'], ['sd', 'sd', 'the standard deviation']]);
        else if (kind === 'bernoulli') params = read([['p', 'p', 'the p value']]);
        else if (kind === 'binomial') params = read([['bp', 'p', 'the p value'], ['trials', 'trials', 'the number of trials']]);
        else if (kind === 'poisson') params = read([['lambda', 'lambda', 'lambda']]);
        else if (kind === 'patterned') params = read([['pfrom', 'from', 'the first number'], ['pto', 'to', 'the last number'], ['step', 'step', 'the step'], ['each', 'repeatEach', 'the repeat count'], ['times', 'repeatSequence', 'the sequence repeat count']]);
        else {
          const found = resolve('pairs', 'value and probability input range'); if (failed(found)) return found;
          const block = readBlock(wb, found.sheetId, found.range);
          if (block[0]?.length !== 2) return problem('The value and probability range needs two columns: the values, then their probabilities.', 'pairs');
          params = { values: block.map((row) => row[0]), probabilities: block.map((row) => row[1]) };
        }
        if (failed(params)) return params;
        return { layout: randomNumbers({ variables: vars, count, distribution: kind, seed, params }), inputs: [], field: 'vars' };
      },
    },
    rank: {
      fields: () => [range('input', 'Input range', selectionText(ctx)), ...grouping()],
      run: () => { const g = groupsOf('input', 'input range'); if (failed(g)) return g; return { layout: rankAndPercentile(g.groups), inputs: [g.found], field: 'input' }; },
    },
    regression: {
      fields: () => [range('y', 'Input Y range', selectionText(ctx)), range('x', 'Input X range'),
        el('div.da-options', {}, check('labels', 'Labels'), check('zero', 'Constant is zero'), checkedNumber('confidence', 'Confidence level (%)', 95)),
        el('fieldset.da-group', {}, el('legend.field-label', {}, 'Residuals'),
          check('residuals', 'Residuals'), check('standardized', 'Standardized residuals'), check('residualPlots', 'Residual plots'), check('lineFit', 'Line fit plots')),
        el('fieldset.da-group', {}, el('legend.field-label', {}, 'Normal probability'), check('normal', 'Normal probability plots'))],
      run: () => {
        const yIn = single('y', 'input Y range', { defaultLabel: () => 'Y' }); if (failed(yIn)) return yIn;
        const xFound = resolve('x', 'input X range'); if (failed(xFound)) return xFound;
        const xIn = readGroups(wb, xFound.sheetId, xFound.range, { by: 'columns', labels: f.labels.checked, name: 'Input X range', defaultLabel: () => null });
        if (xIn.error) return problem(xIn.error, 'x');
        if (xIn.groups[0].values.length !== yIn.group.values.length) return problem('The Y range and the X range must have the same number of rows.', 'x');
        let confidence = 0.95;
        if (f.confidence.checked) { confidence = percentOf('confidenceValue', 'the confidence level'); if (failed(confidence)) return confidence; }
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
        const method = radios('method', 'Sampling method', [['periodic', 'Periodic'], ['random', 'Random']], 'periodic');
        return [range('input', 'Input range', selectionText(ctx)), check('labels', 'Labels'), method,
          number('period', 'Period', 2), number('count', 'Number of samples', 10), number('seed', 'Random seed (optional)', '')];
      },
      run: () => {
        const g = groupsOf('input', 'input range', { by: 'columns' }); if (failed(g)) return g;
        const values = g.groups.flatMap((x) => x.values);
        const method = f.method.value;
        const opt = { method, label: f.labels.checked && g.groups.length === 1 ? g.groups[0].label : null };
        if (method === 'periodic') { const p = wholeOf('period', 'the period'); if (failed(p)) return p; opt.period = p; } else {
          const n = wholeOf('count', 'the number of samples'); if (failed(n)) return n; opt.count = n;
          const seed = num('seed', 'the random seed', { optional: true }); if (failed(seed)) return seed; opt.seed = seed;
        }
        return { layout: sampling(values, opt), inputs: [g.found], field: method === 'periodic' ? 'period' : 'count' };
      },
    },
    tpaired: { fields: () => twoSampleFields(), run: tRun('paired') },
    tequal: { fields: () => twoSampleFields(), run: tRun('equal') },
    tunequal: { fields: () => twoSampleFields(), run: tRun('unequal') },
    ztest: {
      fields: () => twoSampleFields([number('var1', 'Variable 1 variance (known)', ''), number('var2', 'Variable 2 variance (known)', '')]),
      run: () => {
        const v = twoVariables(); if (failed(v)) return v;
        const difference = num('difference', 'the hypothesized mean difference', { optional: true }); if (failed(difference)) return difference;
        const v1 = num('var1', 'the variance of variable 1'); if (failed(v1)) return v1;
        if (!(v1 > 0)) return problem('A known variance must be greater than 0.', 'var1');
        const v2 = num('var2', 'the variance of variable 2'); if (failed(v2)) return v2;
        if (!(v2 > 0)) return problem('A known variance must be greater than 0.', 'var2');
        const a = withAlpha(); if (failed(a)) return a;
        return { layout: zTest(v.g1, v.g2, { difference: difference ?? 0, variance1: v1, variance2: v2, alpha: a }), inputs: v.inputs, field: 'range1' };
      },
    },
  };

  const tool = TOOLS_UI[id];
  if (!tool) return null;
  const fields = tool.fields();

  /* ---- Output options ---- */
  const outputs = radios('output', 'Output options', [['range', 'Output range'], ['sheet', 'New sheet'], ['book', 'New spreadsheet']], 'sheet');
  const outRange = el('input.input', { type: 'text', 'aria-label': 'Output range', autocomplete: 'off', spellcheck: false, placeholder: 'e.g. $E$1' });
  const sheetName = el('input.input', { type: 'text', 'aria-label': 'New sheet name', autocomplete: 'off', placeholder: 'Name (optional)', maxLength: 31 });
  const bookName = el('input.input', { type: 'text', 'aria-label': 'New spreadsheet name', autocomplete: 'off', value: toolName(id).replace(/[:/\\]/g, ' -') });
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
    const res = tool.run();
    if (failed(res)) return refuse(res.field ? (f[res.field]?.inputs?.[0] || f[res.field]) : null, res.error);
    const { layout } = res;
    if (layout.error) return refuse(res.field ? f[res.field] : null, layout.error);
    const mode = f.output.value;
    if (mode === 'range') {
      const target = resolve('outRange', 'output range');
      if (failed(target)) return refuse(outRange, target.error);
      const { rows, cols } = layoutSize(layout);
      const box = { sheetId: target.sheetId, range: { r1: target.range.r1, c1: target.range.c1, r2: target.range.r1 + rows - 1, c2: target.range.c1 + cols - 1 } };
      if (res.inputs.some((input) => overlaps(input, box))) {
        const ok = await confirmDialog({ title: 'Output covers the input', message: 'The results would be written over part of the input range. Write them there anyway?', confirmLabel: 'Write over', danger: true });
        if (!ok) return;
      } else if (outputOccupied(wb, target.sheetId, layout, target.range.r1, target.range.c1)) {
        const ok = await confirmDialog({ title: 'Replace existing data?', message: `The results need ${rows} row${rows === 1 ? '' : 's'} by ${cols} column${cols === 1 ? '' : 's'} from the output cell, and some of those cells hold data. Replace it?`, confirmLabel: 'Replace', danger: true });
        if (!ok) return;
      }
      const out = writeAnalysisOutput(wb, layout, { kind: 'range', sheetId: target.sheetId, r: target.range.r1, c: target.range.c1 });
      if (out.error) return refuse(outRange, out.error);
      modal.close();
      if (out.sheetId !== ctx.sheetId()) wb.setActiveSheet(out.sheetId);
      ctx.grid?.setSelection?.(S.fromRange(out.range), { scroll: true });
      toast(`${toolName(id)} written to ${quoteSheet(wb.sheet(out.sheetId).name)}!${colName(out.range.c1)}${out.range.r1 + 1}`, { icon: 'check' });
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
      toast(`${toolName(id)} written to a new sheet`, { icon: 'check' });
      return;
    }
    const clean = P.sanitizeName(bookName.value).replace(/\.xlsx$/i, '');
    if (!clean) return refuse(bookName, 'Enter a name for the new spreadsheet');
    const book = analysisWorkbook(wb, layout, 'Sheet1');
    if (!book) return refuse(null, 'The new spreadsheet could not be made.');
    busy = true;
    try {
      const fileName = await P.uniqueName(clean);
      const path = `${P.FOLDER}/${fileName}`;
      const written = await P.writeFile(path, await workbookToXlsx(book), { dedupe: true });
      const savedName = written?.name || P.displayName(written?.path || path);
      const saved = P.canonicalPath(`${P.FOLDER}/${savedName}`, written);
      modal.close();
      toast(`${toolName(id)} saved as ${stripExtension(savedName)}`, { icon: 'check', action: { label: 'Open', onClick: () => ctx.run?.('openFile', saved) } });
    } catch (err) {
      refuse(null, `Could not save the new spreadsheet: ${err?.message || 'unknown error'}`);
    } finally {
      busy = false;
    }
  };

  const content = el('form.da-dialog', { onsubmit: submit },
    el('p.small.muted', {}, TOOL_HINTS[id]),
    el('div.da-fields', {}, ...fields),
    outputs,
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => { modal.close(); openDataAnalysis(ctx); } }, 'Back'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const first = Object.values(f).find((node) => node instanceof HTMLInputElement && node.type === 'text' && !node.disabled);
  const modal = openModal({ title: toolName(id), content, initialFocus: first, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
