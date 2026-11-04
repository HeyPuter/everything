/**
 * Drawing an equation text box: its source built up as MathML inside the box's body, on the sheet and on
 * the printed page, in the box's size, colour and alignment.
 */
import { el } from './dom.js';
import { t } from '../i18n/index.js';
import { textBoxStyle } from '../core/charts.js';
import { equationMathML, equationText, EQUATION_DEFAULT_SIZE, estimateEquationSize } from '../core/equation.js';

/** A MathML element for `source`. */
export function mathElement(source, { display = true } = {}) {
  const holder = el('span.equation-math');
  holder.innerHTML = equationMathML(source, { display });
  return holder;
}

/** The body of an equation text box (`extra` adds CSS, such as a theme effect). */
export function equationBody(obj, scale = 1, extra = {}) {
  const style = textBoxStyle(obj, scale);
  return el('div.text-body.equation-body', {
    style: { ...style, justifyContent: { left: 'flex-start', right: 'flex-end' }[obj.style?.align] || 'center', ...extra },
    role: 'math', 'aria-label': t('equationView.label', { text: equationText(obj.equation) }),
  }, mathElement(obj.equation));
}

/** The size the box needs for `source` at `size` pixels: measured in the page when it can be, estimated otherwise. */
export function measureEquation(source, size = EQUATION_DEFAULT_SIZE) {
  const guess = estimateEquationSize(source, size);
  if (typeof document === 'undefined' || !document.body) return guess;
  const probe = el('div.equation-probe', { style: { fontSize: `${size}px` } }, mathElement(source));
  document.body.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  if (!rect.width || !rect.height) return guess;
  return { w: Math.ceil(Math.min(900, Math.max(60, rect.width + 28))), h: Math.ceil(Math.min(600, Math.max(30, rect.height + 20))) };
}
