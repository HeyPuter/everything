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

const P = PLACEHOLDER;
const t = (label, source) => ({ label, source });
/** The Structures group: each structure's templates, empty boxes (⬚) where its parts go. */
export const STRUCTURES = Object.freeze([
  { key: 'fraction', label: 'Fraction', glyph: '½', templates: [t('Stacked Fraction', `\\frac{${P}}{${P}}`), t('Linear Fraction', `${P}/${P}`), t('Stack', `\\stack{${P}}{${P}}`),
    t('Differential', '\\frac{dy}{dx}'), t('Change in y over change in x', '\\frac{\\Delta y}{\\Delta x}'), t('Partial Differential', '\\frac{\\partial y}{\\partial x}'), t('Pi Over 2', '\\frac{\\pi}{2}')] },
  { key: 'script', label: 'Script', glyph: 'eˣ', templates: [t('Superscript', `${P}^{${P}}`), t('Subscript', `${P}_{${P}}`), t('Subscript-Superscript', `${P}_{${P}}^{${P}}`),
    t('Left Subscript-Superscript', `{}_{${P}}^{${P}}${P}`), t('Subscript with Superscript', 'x_{y^2}'), t('Exponential', 'e^{-i\\omega t}'), t('x Squared', 'x^2')] },
  { key: 'radical', label: 'Radical', glyph: '√x', templates: [t('Square Root', `\\sqrt{${P}}`), t('Radical with Degree', `\\sqrt[${P}]{${P}}`), t('Cube Root', `\\sqrt[3]{${P}}`),
    t('Quadratic Formula Root', '\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}'), t('Square Root of a Sum of Squares', '\\sqrt{a^2+b^2}')] },
  { key: 'integral', label: 'Integral', glyph: '∫', templates: [t('Integral', `\\int{${P}}`), t('Integral with Limits', `\\int_{${P}}^{${P}}{${P}}`), t('Double Integral', `\\iint{${P}}`),
    t('Double Integral with Limits', `\\iint_{${P}}^{${P}}{${P}}`), t('Triple Integral', `\\iiint{${P}}`), t('Contour Integral', `\\oint{${P}}`),
    t('Contour Integral with Limits', `\\oint_{${P}}^{${P}}{${P}}`), t('Differential x', 'dx'), t('Differential theta', 'd\\theta')] },
  { key: 'largeOperator', label: 'Large Operator', glyph: '∑', templates: [t('Summation', `\\sum{${P}}`), t('Summation with Limits', `\\sum_{${P}}^{${P}}{${P}}`),
    t('Summation with Subscript Limit', `\\sum_{${P}}{${P}}`), t('Product with Limits', `\\prod_{${P}}^{${P}}{${P}}`), t('Co-Product with Limits', `\\coprod_{${P}}^{${P}}{${P}}`),
    t('Union with Limits', `\\bigcup_{${P}}^{${P}}{${P}}`), t('Intersection with Limits', `\\bigcap_{${P}}^{${P}}{${P}}`), t('Summation over k of n choose k', '\\sum_{k}{\\binom{n}{k}}'),
    t('Summation from i equals 0 to n', '\\sum_{i=0}^{n}{i}')] },
  { key: 'bracket', label: 'Bracket', glyph: '{()}', templates: [t('Parentheses', `(${P})`), t('Brackets', `[${P}]`), t('Braces', `\\{${P}\\}`), t('Single Bars', `|${P}|`),
    t('Double Bars', `\\|${P}\\|`), t('Angle Brackets', `\\langle ${P}\\rangle`), t('Floor', `\\lfloor ${P}\\rfloor`), t('Ceiling', `\\lceil ${P}\\rceil`),
    t('Cases', `\\cases{${P} \\\\ ${P}}`), t('Binomial Coefficient', `\\binom{${P}}{${P}}`)] },
  { key: 'function', label: 'Function', glyph: 'sin θ', templates: [t('Sine', `\\sin{${P}}`), t('Cosine', `\\cos{${P}}`), t('Tangent', `\\tan{${P}}`), t('Cosecant', `\\csc{${P}}`),
    t('Secant', `\\sec{${P}}`), t('Cotangent', `\\cot{${P}}`), t('Inverse Sine', `\\sin^{-1}{${P}}`), t('Inverse Cosine', `\\cos^{-1}{${P}}`), t('Inverse Tangent', `\\tan^{-1}{${P}}`),
    t('Hyperbolic Sine', `\\sinh{${P}}`), t('Hyperbolic Cosine', `\\cosh{${P}}`), t('Hyperbolic Tangent', `\\tanh{${P}}`), t('Sine theta', '\\sin{\\theta}'),
    t('Tangent formula', '\\tan{\\theta}=\\frac{\\sin{\\theta}}{\\cos{\\theta}}')] },
  { key: 'accent', label: 'Accent', glyph: 'ä', templates: [t('Dot', `\\dot{${P}}`), t('Double Dot', `\\ddot{${P}}`), t('Hat', `\\hat{${P}}`), t('Check', `\\check{${P}}`),
    t('Acute', `\\acute{${P}}`), t('Grave', `\\grave{${P}}`), t('Breve', `\\breve{${P}}`), t('Tilde', `\\tilde{${P}}`), t('Overbar', `\\overline{${P}}`), t('Vector', `\\vec{${P}}`)] },
  { key: 'limitLog', label: 'Limit and Log', glyph: 'lim', templates: [t('Logarithm with Base', `\\log_{${P}}{${P}}`), t('Logarithm', `\\log{${P}}`), t('Limit', `\\lim_{${P}}{${P}}`),
    t('Minimum', `\\min_{${P}}{${P}}`), t('Maximum', `\\max_{${P}}{${P}}`), t('Natural Logarithm', `\\ln{${P}}`),
    t('Limit of (1 + 1/n)^n', '\\lim_{n\\to\\infty}{\\left(1+\\frac{1}{n}\\right)^n}')] },
  { key: 'operator', label: 'Operator', glyph: '≝', templates: [t('Colon Equal', ':='), t('Equal Equal', '=='), t('Plus Equal', '+='), t('Minus Equal', '-='),
    t('Equal by Definition', '\\overset{def}{=}'), t('Delta Equal To', '\\overset{\\Delta}{=}'), t('Arrow with Text Above', `\\overset{${P}}{\\rightarrow}`),
    t('Arrow with Text Below', `\\underset{${P}}{\\rightarrow}`), t('Text Below', `\\underset{${P}}{${P}}`), t('Text Above', `\\overset{${P}}{${P}}`)] },
  { key: 'matrix', label: 'Matrix', glyph: '[⋮]', templates: [t('1×2 Empty Matrix', `\\matrix{${P} & ${P}}`), t('2×1 Empty Matrix', `\\matrix{${P} \\\\ ${P}}`),
    t('2×2 Empty Matrix', `\\matrix{${P} & ${P} \\\\ ${P} & ${P}}`), t('2×2 Matrix with Parentheses', `\\pmatrix{${P} & ${P} \\\\ ${P} & ${P}}`),
    t('2×2 Matrix with Brackets', `\\bmatrix{${P} & ${P} \\\\ ${P} & ${P}}`), t('3×3 Empty Matrix', `\\matrix{${P} & ${P} & ${P} \\\\ ${P} & ${P} & ${P} \\\\ ${P} & ${P} & ${P}}`),
    t('Determinant', `\\vmatrix{${P} & ${P} \\\\ ${P} & ${P}}`), t('2×2 Identity Matrix', '\\pmatrix{1 & 0 \\\\ 0 & 1}'),
    t('3×3 Identity Matrix', '\\pmatrix{1 & 0 & 0 \\\\ 0 & 1 & 0 \\\\ 0 & 0 & 1}'), t('Midline Dots', '\\cdots'), t('Vertical Dots', '\\vdots'), t('Diagonal Dots', '\\ddots')] },
]);

const chars = text => [...text.replace(/\s+/g, '')];
/** The symbol palette's categories, as the Symbols gallery groups them. */
export const SYMBOL_SETS = Object.freeze([
  { name: 'Basic Math', symbols: chars('± ∞ = ≠ ∼ × ÷ ! ∝ < ≪ > ≫ ≤ ≥ ∓ ≅ ≈ ≡ ∀ ∁ ∂ √ ∛ ∜ ∪ ∩ ∅ % ° ℉ ℃ ∆ ∇ ∃ ∄ ∈ ∋ ← ↑ → ↓ ↔ ∴ + − ¬ α β γ δ ε ϵ θ ϑ μ π ρ σ τ φ ω ∗ ∙ ⋮ ⋯ ⋰ ⋱ ℵ ℶ ∎') },
  { name: 'Greek Letters', symbols: chars('α β γ δ ε ϵ ζ η θ ϑ ι κ λ μ ν ξ ο π ϖ ρ ϱ σ ς τ υ φ ϕ χ ψ ω Α Β Γ Δ Ε Ζ Η Θ Ι Κ Λ Μ Ν Ξ Ο Π Ρ Σ Τ Υ Φ Χ Ψ Ω') },
  { name: 'Letter-Like Symbols', symbols: chars('∀ ∁ ℂ ∂ ð ℇ ℱ ℊ ℋ ℌ ℍ ℎ ℏ ı ℑ ȷ ℒ ℓ ℕ ℘ ℙ ℚ ℛ ℜ ℝ ℤ ℧ Å ℬ ℰ ℳ ℵ ℶ ℷ ℸ') },
  { name: 'Operators', symbols: chars('+ − ± ∓ × ÷ ⋅ ∘ ∗ ∙ ⊕ ⊗ ∪ ∩ ∧ ∨ ∖ = ≠ < > ≤ ≥ ≪ ≫ ≈ ≅ ≡ ∼ ∝ ∈ ∉ ⊂ ⊃ ⊆ ⊇ ∥ ⊥ ∴ ∵') },
  { name: 'Arrows', symbols: chars('← → ↑ ↓ ↔ ↕ ⇐ ⇒ ⇑ ⇓ ⇔ ↦ ↗ ↘ ↖ ↙ ⟵ ⟶ ⟷') },
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

/** Insert ▸ Equation's arrow: the built-in equations, each drawn, then Insert New Equation. */
export function equationGalleryItems(ctx) {
  const pick = def => el('button.menu-item.equation-builtin', {
    type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': def.label, title: def.label,
    onclick: () => { closeMenu(); ctx.run('insertEquation', def.key); },
  }, el('span.equation-builtin-name', {}, def.label), mathElement(def.source));
  return [{ header: 'Built-In' }, { custom: el('div.equation-builtins', { role: 'group', 'aria-label': 'Built-in equations' }, ...BUILTIN_EQUATIONS.map(pick)) },
    { separator: true }, { label: 'Insert New Equation', icon: 'math', cmd: 'insertEquation', arg: null }];
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
  const input = el('textarea.input.equation-source', { rows: 3, spellcheck: false, 'aria-label': 'Equation (linear format)',
    placeholder: 'Type equation here, e.g. x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a} or a^2+b^2=c^2', value: initial });
  const preview = el('div.equation-preview', { 'aria-live': 'polite', 'aria-label': 'Preview' });
  const paint = () => {
    const src = input.value;
    preview.replaceChildren(src.trim() ? mathElement(src) : el('span.field-hint', {}, 'Type equation here.'));
    preview.setAttribute('aria-label', src.trim() ? `Preview: ${equationText(src)}` : 'Preview: empty');
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
  const templates = el('div.equation-templates', { role: 'group', 'aria-label': 'Templates' });
  const structureButtons = STRUCTURES.map(s => el('button.equation-structure', {
    type: 'button', 'aria-pressed': 'false', 'aria-label': s.label, title: s.label, dataset: { key: s.key },
    onclick: () => showStructure(s.key),
  }, el('span.equation-structure-glyph', { 'aria-hidden': 'true' }, s.glyph), el('span', {}, s.label)));
  const showStructure = key => {
    const s = STRUCTURES.find(x => x.key === key);
    for (const b of structureButtons) b.setAttribute('aria-pressed', String(b.dataset.key === key));
    templates.setAttribute('aria-label', `${s.label} templates`);
    templates.replaceChildren(...s.templates.map(tp => el('button.equation-template-btn', {
      type: 'button', title: tp.label, 'aria-label': tp.label, onclick: () => place(tp.source),
    }, mathElement(tp.source, { display: false }))));
  };

  // Symbols: a category and its characters.
  const symbolGrid = el('div.equation-symbols', { role: 'group', 'aria-label': 'Symbols' });
  const showSymbols = name => {
    const set = SYMBOL_SETS.find(x => x.name === name) || SYMBOL_SETS[0];
    symbolGrid.replaceChildren(...set.symbols.map(ch => el('button.equation-symbol', { type: 'button', title: ch, 'aria-label': `Insert ${ch}`, onclick: () => place(ch) }, ch)));
  };
  const symbolSet = el('select.select', { 'aria-label': 'Symbol set', onchange: () => showSymbols(symbolSet.value) },
    SYMBOL_SETS.map(s => el('option', { value: s.name }, s.name)));
  showSymbols(SYMBOL_SETS[0].name);

  const size = sizeOf(equation);
  const sizes = [...new Set([...TEXT_SIZES, EQUATION_DEFAULT_SIZE, size])].sort((a, b) => a - b);
  const sizeSel = el('select.select', { 'aria-label': 'Font size' }, sizes.map(n => el('option', { value: String(n), selected: n === size }, `${Math.round(n * 0.75 * 2) / 2} pt`)));

  const { alert: error, refuse } = fieldAlert('equation');
  const submit = (e) => {
    e?.preventDefault();
    if (wb.isProtected(sheetId)) return refuse(null, 'This sheet is protected. Unprotect it before changing equations.');
    const src = input.value.trim();
    if (!src) return refuse(input, 'Type an equation');
    if (src.length > TEXT_MAX_LENGTH) return refuse(input, `Use ${TEXT_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`);
    const px = Number(sizeSel.value) || EQUATION_DEFAULT_SIZE;
    if (equation) {
      // The box keeps its place and fits its equation again.
      const { w, h } = measureEquation(src, px);
      wb.updateChart(sheetId, equation.id, { equation: src, text: equationText(src), style: { ...equation.style, size: px }, w, h }, 'Edit equation');
    } else insertEquation(ctx, src, { size: px });
    modal.close();
  };
  input.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
  });

  const content = el('form.equation-dialog', { onsubmit: submit },
    el('div.equation-structures', { role: 'toolbar', 'aria-label': 'Structures' }, ...structureButtons),
    templates,
    el('div.equation-symbols-head', {}, el('span.field-label', {}, 'Symbols'), symbolSet),
    symbolGrid,
    el('label.field', {}, el('span.field-label', {}, 'Equation'), input, error,
      el('span.field-hint', {}, 'Linear format: a/b, x^2, x_i, \\sqrt{x}, \\sum_{k=0}^{n}, \\int_0^\\infty, \\alpha, \\pm. Ctrl+Enter inserts.')),
    preview,
    el('div.row.row-end', {},
      el('label.field.equation-size', {}, el('span.field-label', {}, 'Size'), sizeSel),
      equation && el('button.btn.btn-ghost.btn-danger', { type: 'button', onclick: () => { modal.close(); ctx.run('deleteChart', { id: equation.id, only: true }); } }, 'Delete'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, equation ? 'Save' : 'Insert')));
  showStructure(STRUCTURES[0].key);
  paint();
  const modal = openModal({ title: equation ? 'Edit Equation' : 'Equation', content, wide: true, className: 'equation-modal', initialFocus: input, onClose: () => ctx.grid.focus() });
  return modal;
}
