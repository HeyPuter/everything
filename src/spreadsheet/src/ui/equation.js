/**
 * Insert ▸ Symbols ▸ Equation. The button opens the Equation editor; its arrow offers the built-in
 * equations, which go straight onto the sheet. The editor is an Equation tab as a dialog: the
 * Structures (Fraction, Script, Radical, Integral, Large Operator, Bracket, Function, Accent, Limit and
 * Log, Operator, Matrix), a symbol palette, the linear source and the equation drawn built up as it is
 * typed. An equation is a text box holding its source (`equation`), so it moves, sizes, prints and saves
 * as text boxes do; in a file it is a text box carrying Office Math.
 */
import { el, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { closeMenu } from './menu.js';
import { TEXT_SIZES, TEXT_MAX_LENGTH } from '../core/charts.js';
import { BUILTIN_EQUATIONS, builtinEquation, equationText, EQUATION_DEFAULT_SIZE, PLACEHOLDER } from '../core/equation.js';
import { mathElement, measureEquation } from './equation-view.js';
import { t } from '../i18n/index.js';

const P = PLACEHOLDER;
/** A template: its name (a catalog key, read in the interface language) and its source. */
const tpl = (label, source) => ({ get label() { return t(label); }, source });
/** The Structures group: each structure's templates, empty boxes (⬚) where its parts go. */
export const STRUCTURES = Object.freeze([
  { key: 'fraction', get label() { return t('equation.structure.fraction'); }, glyph: '½', templates: [tpl('equation.template.stackedFraction', `\\frac{${P}}{${P}}`), tpl('equation.template.linearFraction', `${P}/${P}`), tpl('equation.template.stack', `\\stack{${P}}{${P}}`),
    tpl('equation.template.differential', '\\frac{dy}{dx}'), tpl('equation.template.changeInYOverChangeInX', '\\frac{\\Delta y}{\\Delta x}'), tpl('equation.template.partialDifferential', '\\frac{\\partial y}{\\partial x}'), tpl('equation.template.piOver2', '\\frac{\\pi}{2}')] },
  { key: 'script', get label() { return t('equation.structure.script'); }, glyph: 'eˣ', templates: [tpl('equation.template.superscript', `${P}^{${P}}`), tpl('equation.template.subscript', `${P}_{${P}}`), tpl('equation.template.subscriptSuperscript', `${P}_{${P}}^{${P}}`),
    tpl('equation.template.leftSubscriptSuperscript', `{}_{${P}}^{${P}}${P}`), tpl('equation.template.subscriptWithSuperscript', 'x_{y^2}'), tpl('equation.template.exponential', 'e^{-i\\omega t}'), tpl('equation.template.xSquared', 'x^2')] },
  { key: 'radical', get label() { return t('equation.structure.radical'); }, glyph: '√x', templates: [tpl('equation.template.squareRoot', `\\sqrt{${P}}`), tpl('equation.template.radicalWithDegree', `\\sqrt[${P}]{${P}}`), tpl('equation.template.cubeRoot', `\\sqrt[3]{${P}}`),
    tpl('equation.template.quadraticFormulaRoot', '\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}'), tpl('equation.template.squareRootOfASumOfSquares', '\\sqrt{a^2+b^2}')] },
  { key: 'integral', get label() { return t('equation.structure.integral'); }, glyph: '∫', templates: [tpl('equation.template.integral', `\\int{${P}}`), tpl('equation.template.integralWithLimits', `\\int_{${P}}^{${P}}{${P}}`), tpl('equation.template.doubleIntegral', `\\iint{${P}}`),
    tpl('equation.template.doubleIntegralWithLimits', `\\iint_{${P}}^{${P}}{${P}}`), tpl('equation.template.tripleIntegral', `\\iiint{${P}}`), tpl('equation.template.contourIntegral', `\\oint{${P}}`),
    tpl('equation.template.contourIntegralWithLimits', `\\oint_{${P}}^{${P}}{${P}}`), tpl('equation.template.differentialX', 'dx'), tpl('equation.template.differentialTheta', 'd\\theta')] },
  { key: 'largeOperator', get label() { return t('equation.structure.largeOperator'); }, glyph: '∑', templates: [tpl('equation.template.summation', `\\sum{${P}}`), tpl('equation.template.summationWithLimits', `\\sum_{${P}}^{${P}}{${P}}`),
    tpl('equation.template.summationWithSubscriptLimit', `\\sum_{${P}}{${P}}`), tpl('equation.template.productWithLimits', `\\prod_{${P}}^{${P}}{${P}}`), tpl('equation.template.coProductWithLimits', `\\coprod_{${P}}^{${P}}{${P}}`),
    tpl('equation.template.unionWithLimits', `\\bigcup_{${P}}^{${P}}{${P}}`), tpl('equation.template.intersectionWithLimits', `\\bigcap_{${P}}^{${P}}{${P}}`), tpl('equation.template.summationOverKOfNChooseK', '\\sum_{k}{\\binom{n}{k}}'),
    tpl('equation.template.summationFromIEquals0ToN', '\\sum_{i=0}^{n}{i}')] },
  { key: 'bracket', get label() { return t('equation.structure.bracket'); }, glyph: '{()}', templates: [tpl('equation.template.parentheses', `(${P})`), tpl('equation.template.brackets', `[${P}]`), tpl('equation.template.braces', `\\{${P}\\}`), tpl('equation.template.singleBars', `|${P}|`),
    tpl('equation.template.doubleBars', `\\|${P}\\|`), tpl('equation.template.angleBrackets', `\\langle ${P}\\rangle`), tpl('equation.template.floor', `\\lfloor ${P}\\rfloor`), tpl('equation.template.ceiling', `\\lceil ${P}\\rceil`),
    tpl('equation.template.cases', `\\cases{${P} \\\\ ${P}}`), tpl('equation.template.binomialCoefficient', `\\binom{${P}}{${P}}`)] },
  { key: 'function', get label() { return t('equation.structure.function'); }, glyph: 'sin θ', templates: [tpl('equation.template.sine', `\\sin{${P}}`), tpl('equation.template.cosine', `\\cos{${P}}`), tpl('equation.template.tangent', `\\tan{${P}}`), tpl('equation.template.cosecant', `\\csc{${P}}`),
    tpl('equation.template.secant', `\\sec{${P}}`), tpl('equation.template.cotangent', `\\cot{${P}}`), tpl('equation.template.inverseSine', `\\sin^{-1}{${P}}`), tpl('equation.template.inverseCosine', `\\cos^{-1}{${P}}`), tpl('equation.template.inverseTangent', `\\tan^{-1}{${P}}`),
    tpl('equation.template.hyperbolicSine', `\\sinh{${P}}`), tpl('equation.template.hyperbolicCosine', `\\cosh{${P}}`), tpl('equation.template.hyperbolicTangent', `\\tanh{${P}}`), tpl('equation.template.sineTheta', '\\sin{\\theta}'),
    tpl('equation.template.tangentFormula', '\\tan{\\theta}=\\frac{\\sin{\\theta}}{\\cos{\\theta}}')] },
  { key: 'accent', get label() { return t('equation.structure.accent'); }, glyph: 'ä', templates: [tpl('equation.template.dot', `\\dot{${P}}`), tpl('equation.template.doubleDot', `\\ddot{${P}}`), tpl('equation.template.hat', `\\hat{${P}}`), tpl('equation.template.check', `\\check{${P}}`),
    tpl('equation.template.acute', `\\acute{${P}}`), tpl('equation.template.grave', `\\grave{${P}}`), tpl('equation.template.breve', `\\breve{${P}}`), tpl('equation.template.tilde', `\\tilde{${P}}`), tpl('equation.template.overbar', `\\overline{${P}}`), tpl('equation.template.vector', `\\vec{${P}}`)] },
  { key: 'limitLog', get label() { return t('equation.structure.limitLog'); }, glyph: 'lim', templates: [tpl('equation.template.logarithmWithBase', `\\log_{${P}}{${P}}`), tpl('equation.template.logarithm', `\\log{${P}}`), tpl('equation.template.limit', `\\lim_{${P}}{${P}}`),
    tpl('equation.template.minimum', `\\min_{${P}}{${P}}`), tpl('equation.template.maximum', `\\max_{${P}}{${P}}`), tpl('equation.template.naturalLogarithm', `\\ln{${P}}`),
    tpl('equation.template.limitOf11NN', '\\lim_{n\\to\\infty}{\\left(1+\\frac{1}{n}\\right)^n}')] },
  { key: 'operator', get label() { return t('equation.structure.operator'); }, glyph: '≝', templates: [tpl('equation.template.colonEqual', ':='), tpl('equation.template.equalEqual', '=='), tpl('equation.template.plusEqual', '+='), tpl('equation.template.minusEqual', '-='),
    tpl('equation.template.equalByDefinition', '\\overset{def}{=}'), tpl('equation.template.deltaEqualTo', '\\overset{\\Delta}{=}'), tpl('equation.template.arrowWithTextAbove', `\\overset{${P}}{\\rightarrow}`),
    tpl('equation.template.arrowWithTextBelow', `\\underset{${P}}{\\rightarrow}`), tpl('equation.template.textBelow', `\\underset{${P}}{${P}}`), tpl('equation.template.textAbove', `\\overset{${P}}{${P}}`)] },
  { key: 'matrix', get label() { return t('equation.structure.matrix'); }, glyph: '[⋮]', templates: [tpl('equation.template.m1x2EmptyMatrix', `\\matrix{${P} & ${P}}`), tpl('equation.template.m2x1EmptyMatrix', `\\matrix{${P} \\\\ ${P}}`),
    tpl('equation.template.m2x2EmptyMatrix', `\\matrix{${P} & ${P} \\\\ ${P} & ${P}}`), tpl('equation.template.m2x2MatrixWithParentheses', `\\pmatrix{${P} & ${P} \\\\ ${P} & ${P}}`),
    tpl('equation.template.m2x2MatrixWithBrackets', `\\bmatrix{${P} & ${P} \\\\ ${P} & ${P}}`), tpl('equation.template.m3x3EmptyMatrix', `\\matrix{${P} & ${P} & ${P} \\\\ ${P} & ${P} & ${P} \\\\ ${P} & ${P} & ${P}}`),
    tpl('equation.template.determinant', `\\vmatrix{${P} & ${P} \\\\ ${P} & ${P}}`), tpl('equation.template.m2x2IdentityMatrix', '\\pmatrix{1 & 0 \\\\ 0 & 1}'),
    tpl('equation.template.m3x3IdentityMatrix', '\\pmatrix{1 & 0 & 0 \\\\ 0 & 1 & 0 \\\\ 0 & 0 & 1}'), tpl('equation.template.midlineDots', '\\cdots'), tpl('equation.template.verticalDots', '\\vdots'), tpl('equation.template.diagonalDots', '\\ddots')] },
]);

const chars = text => [...text.replace(/\s+/g, '')];
/** The symbol palette's categories, as the Symbols gallery groups them: `name` identifies one, `label` is its name on screen. */
export const SYMBOL_SETS = Object.freeze([
  { name: 'Basic Math', get label() { return t('equation.symbolSet.basicMath'); }, symbols: chars('± ∞ = ≠ ∼ × ÷ ! ∝ < ≪ > ≫ ≤ ≥ ∓ ≅ ≈ ≡ ∀ ∁ ∂ √ ∛ ∜ ∪ ∩ ∅ % ° ℉ ℃ ∆ ∇ ∃ ∄ ∈ ∋ ← ↑ → ↓ ↔ ∴ + − ¬ α β γ δ ε ϵ θ ϑ μ π ρ σ τ φ ω ∗ ∙ ⋮ ⋯ ⋰ ⋱ ℵ ℶ ∎') },
  { name: 'Greek Letters', get label() { return t('equation.symbolSet.greekLetters'); }, symbols: chars('α β γ δ ε ϵ ζ η θ ϑ ι κ λ μ ν ξ ο π ϖ ρ ϱ σ ς τ υ φ ϕ χ ψ ω Α Β Γ Δ Ε Ζ Η Θ Ι Κ Λ Μ Ν Ξ Ο Π Ρ Σ Τ Υ Φ Χ Ψ Ω') },
  { name: 'Letter-Like Symbols', get label() { return t('equation.symbolSet.letterLike'); }, symbols: chars('∀ ∁ ℂ ∂ ð ℇ ℱ ℊ ℋ ℌ ℍ ℎ ℏ ı ℑ ȷ ℒ ℓ ℕ ℘ ℙ ℚ ℛ ℜ ℝ ℤ ℧ Å ℬ ℰ ℳ ℵ ℶ ℷ ℸ') },
  { name: 'Operators', get label() { return t('equation.symbolSet.operators'); }, symbols: chars('+ − ± ∓ × ÷ ⋅ ∘ ∗ ∙ ⊕ ⊗ ∪ ∩ ∧ ∨ ∖ = ≠ < > ≤ ≥ ≪ ≫ ≈ ≅ ≡ ∼ ∝ ∈ ∉ ⊂ ⊃ ⊆ ⊇ ∥ ⊥ ∴ ∵') },
  { name: 'Arrows', get label() { return t('equation.symbolSet.arrows'); }, symbols: chars('← → ↑ ↓ ↔ ↕ ⇐ ⇒ ⇑ ⇓ ⇔ ↦ ↗ ↘ ↖ ↙ ⟵ ⟶ ⟷') },
]);

const sizeOf = obj => obj?.style?.size || EQUATION_DEFAULT_SIZE;

/** Put an equation on the sheet at the active cell, sized to fit and selected; returns its id. */
export function insertEquation(ctx, source, { size = EQUATION_DEFAULT_SIZE } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return null;
  if (wb.isProtected(sheetId)) return null;
  const { w, h } = measureEquation(source, size);
  const a = ctx.active();
  const id = wb.addChart(sheetId, { type: 'text', equation: source, text: equationText(source), anchor: { r: a.r, c: a.c }, dx: 4, dy: 4, w, h,
    style: { size, align: 'center', valign: 'middle', border: false, bg: null, color: null } });
  if (id) ctx.grid.selectChart?.(id);
  return id;
}

/** The built-in equations' names on screen, by key (core/equation.js keeps their English names). */
const BUILTIN_LABELS = {
  circle: 'equation.builtin.circle',
  binomial: 'equation.builtin.binomial',
  sum: 'equation.builtin.sum',
  fourier: 'equation.builtin.fourier',
  pythagoras: 'equation.builtin.pythagoras',
  quadratic: 'equation.builtin.quadratic',
  taylor: 'equation.builtin.taylor',
  trig1: 'equation.builtin.trig1',
  trig2: 'equation.builtin.trig2',
};

/** Insert ▸ Equation's arrow: the built-in equations, each drawn, then Insert New Equation. */
export function equationGalleryItems(ctx) {
  const pick = def => {
    const label = BUILTIN_LABELS[def.key] ? t(BUILTIN_LABELS[def.key]) : def.label;
    return el('button.menu-item.equation-builtin', {
      type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': label, title: label,
      onclick: () => { closeMenu(); ctx.run('insertEquation', def.key); },
    }, el('span.equation-builtin-name', {}, label), mathElement(def.source));
  };
  return [{ header: t('equation.builtIn') }, { custom: el('div.equation-builtins', { role: 'group', 'aria-label': t('equation.builtInEquations') }, ...BUILTIN_EQUATIONS.map(pick)) },
    { separator: true }, { label: t('equation.insertNew'), icon: 'math', cmd: 'insertEquation', arg: null }];
}

/** Run Insert ▸ Equation: a built-in key inserts it, anything else opens the editor for a new one. */
export function runInsertEquation(ctx, arg) {
  const builtin = typeof arg === 'string' ? builtinEquation(arg) : null;
  if (builtin) return insertEquation(ctx, builtin.source);
  return openEquationDialog(ctx);
}

/** The Equation editor, for a new equation or the one `equation` names. */
export function openEquationDialog(ctx, { equation = null, source = '' } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return null;
  const initial = equation?.equation ?? source;
  const input = el('textarea.input.equation-source', { rows: 3, spellcheck: false, 'aria-label': t('equation.sourceLabel'),
    placeholder: t('equation.sourcePlaceholder', { example: 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}', other: 'a^2+b^2=c^2' }), value: initial });
  const preview = el('div.equation-preview', { 'aria-live': 'polite', 'aria-label': t('common.preview') });
  const paint = () => {
    const src = input.value;
    preview.replaceChildren(src.trim() ? mathElement(src) : el('span.field-hint', {}, t('equation.typeHere')));
    preview.setAttribute('aria-label', src.trim() ? t('equation.previewOf', { text: equationText(src) }) : t('equation.previewEmpty'));
  };
  input.addEventListener('input', paint);

  /** Insert a template at the caret: a selection fills its first box, and the next box is selected. */
  const place = (template) => {
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const selected = input.value.slice(start, end);
    const text = selected && template.includes(P) ? template.replace(P, selected) : template;
    // Join a command to a following letter with a space, as the source needs.
    const before = input.value.slice(0, start), after = input.value.slice(end);
    const gap = /\\[A-Za-z]+$/.test(before) && /^[A-Za-z]/.test(text) ? ' ' : '';
    const tail = /\\[A-Za-z]+$/.test(text) && /^[A-Za-z]/.test(after) ? ' ' : '';
    input.value = before + gap + text + tail + after;
    const from = before.length + gap.length;
    const box = input.value.indexOf(P, from);
    input.focus();
    if (box >= 0 && box < from + text.length) input.setSelectionRange(box, box + P.length);
    else input.setSelectionRange(from + text.length + tail.length, from + text.length + tail.length);
    paint();
  };

  // Structures: a row of buttons; the chosen one's templates show beneath, each drawn.
  const templates = el('div.equation-templates', { role: 'group', 'aria-label': t('equation.templates') });
  const structureButtons = STRUCTURES.map(s => el('button.equation-structure', {
    type: 'button', 'aria-pressed': 'false', 'aria-label': s.label, title: s.label, dataset: { key: s.key },
    onclick: () => showStructure(s.key),
  }, el('span.equation-structure-glyph', { 'aria-hidden': 'true' }, s.glyph), el('span', {}, s.label)));
  const showStructure = key => {
    const s = STRUCTURES.find(x => x.key === key);
    for (const b of structureButtons) b.setAttribute('aria-pressed', String(b.dataset.key === key));
    templates.setAttribute('aria-label', t('equation.structureTemplates', { structure: s.label }));
    templates.replaceChildren(...s.templates.map(tp => el('button.equation-template-btn', {
      type: 'button', title: tp.label, 'aria-label': tp.label, onclick: () => place(tp.source),
    }, mathElement(tp.source, { display: false }))));
  };

  // Symbols: a category and its characters.
  const symbolGrid = el('div.equation-symbols', { role: 'group', 'aria-label': t('equation.symbols') });
  const showSymbols = name => {
    const set = SYMBOL_SETS.find(x => x.name === name) || SYMBOL_SETS[0];
    symbolGrid.replaceChildren(...set.symbols.map(ch => el('button.equation-symbol', { type: 'button', title: ch, 'aria-label': t('equation.insertSymbol', { symbol: ch }), onclick: () => place(ch) }, ch)));
  };
  const symbolSet = el('select.select', { 'aria-label': t('equation.symbolSet'), onchange: () => showSymbols(symbolSet.value) },
    SYMBOL_SETS.map(s => el('option', { value: s.name }, s.label)));
  showSymbols(SYMBOL_SETS[0].name);

  const size = sizeOf(equation);
  const sizes = [...new Set([...TEXT_SIZES, EQUATION_DEFAULT_SIZE, size])].sort((a, b) => a - b);
  const sizeSel = el('select.select', { 'aria-label': t('equation.fontSize') }, sizes.map(n => el('option', { value: String(n), selected: n === size }, t('equation.points', { size: Math.round(n * 0.75 * 2) / 2 }))));

  const { alert: error, refuse } = fieldAlert('equation');
  const submit = (e) => {
    e?.preventDefault();
    if (wb.isProtected(sheetId)) return refuse(null, t('equation.protected'));
    const src = input.value.trim();
    if (!src) return refuse(input, t('equation.typeAnEquation'));
    if (src.length > TEXT_MAX_LENGTH) return refuse(input, t('equation.tooLong', { max: TEXT_MAX_LENGTH }));
    const px = Number(sizeSel.value) || EQUATION_DEFAULT_SIZE;
    if (equation) {
      // The box keeps its place and fits its equation again.
      const { w, h } = measureEquation(src, px);
      wb.updateChart(sheetId, equation.id, { equation: src, text: equationText(src), style: { ...equation.style, size: px }, w, h }, t('equation.undoEdit'));
    } else insertEquation(ctx, src, { size: px });
    modal.close();
  };
  input.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
  });

  const content = el('form.equation-dialog', { onsubmit: submit },
    el('div.equation-structures', { role: 'toolbar', 'aria-label': t('equation.structures') }, ...structureButtons),
    templates,
    el('div.equation-symbols-head', {}, el('span.field-label', {}, t('equation.symbols')), symbolSet),
    symbolGrid,
    el('label.field', {}, el('span.field-label', {}, t('equation.equation')), input, error,
      el('span.field-hint', {}, t('equation.linearHint', { examples: 'a/b, x^2, x_i, \\sqrt{x}, \\sum_{k=0}^{n}, \\int_0^\\infty, \\alpha, \\pm' }))),
    preview,
    el('div.row.row-end', {},
      el('label.field.equation-size', {}, el('span.field-label', {}, t('equation.size')), sizeSel),
      equation && el('button.btn.btn-ghost.btn-danger', { type: 'button', onclick: () => { modal.close(); ctx.run('deleteChart', { id: equation.id, only: true }); } }, t('common.delete')),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, equation ? t('common.save') : t('common.insert'))));
  showStructure(STRUCTURES[0].key);
  paint();
  const modal = openModal({ title: equation ? t('equation.editTitle') : t('equation.equation'), content, wide: true, className: 'equation-modal', initialFocus: input, onClose: () => ctx.grid.focus() });
  return modal;
}
