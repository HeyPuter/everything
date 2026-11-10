/**
 * Contextual ribbon tab shown while hatching: boundary options, a pattern
 * gallery with live swatches, scale and angle, and Close.
 */
import { h } from './dom.js';
import { icon } from './icons.js';
import { drawPreview } from './preview.js';
import { PATTERNS } from '../core/hatch/patterns.js';
import { roving } from './roving.js';

/** A scale that shows a few repeats of the pattern in a 20 unit swatch. */
function swatchScale(p) {
  let spacing = 0;
  for (const f of p.families) spacing = Math.max(spacing, Math.abs(f.dy));
  return spacing > 0 ? Math.min(4, 4 / spacing) : 1;
}

export function hatchTab(app, st, onChange) {
  return {
    id: 'hatch',
    label: 'Hatch Creation',
    contextual: true,
    render() {
      const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
      const sq = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0];
      const gallery = h('div.hatch-gallery', { role: 'radiogroup', 'aria-label': 'Hatch pattern' });
      const buttons = [];
      for (const p of PATTERNS) {
        const canvas = h('canvas.hatch-swatch', { width: 44, height: 34, 'aria-hidden': 'true' });
        const btn = h(
          'button.hatch-pat',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(st.pattern === p.name),
            'aria-label': p.name,
            'data-tip': p.name,
            'data-tip-desc': p.description,
            onClick: () => {
              st.pattern = p.name;
              for (const b of buttons) b.setAttribute('aria-checked', String(b === btn));
              syncRoving();
              onChange?.();
            },
          },
          canvas,
        );
        buttons.push(btn);
        gallery.append(btn);
        requestAnimationFrame(() =>
          drawPreview(canvas, app.doc.drawing, [{ type: 'hatch', layer: '0', color: 256, linetype: 'Continuous', lineweight: -3, loops: [sq], pattern: p.name, scale: swatchScale(p), angle: 0 }], {
            fg,
            bounds: [0, 0, 20, 20],
            margin: 0,
          }),
        );
      }
      // The gallery fills two rows column by column.
      const syncRoving = roving(gallery, '.hatch-pat', { h: 2, v: 1 });
      // onSet returns false to reject a value: the box then goes back to the current one.
      const num = (label, get, onSet, attrs) => {
        const inp = h('input.input.sm', {
          type: 'number',
          value: get(),
          'aria-label': label,
          ...attrs,
        });
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key !== 'Escape') return;
          e.preventDefault();
          // First undo what is being typed; with nothing typed, Escape cancels
          // the hatch as it does on the drawing.
          if (inp.value.trim() === '' || Number(inp.value) !== get()) inp.value = get();
          else {
            app.editor.cancel();
            app.focusCanvas();
          }
        });
        inp.addEventListener('change', () => {
          const v = Number(inp.value);
          if (inp.value.trim() !== '' && Number.isFinite(v) && onSet(v) !== false) {
            inp.removeAttribute('aria-invalid');
            onChange?.();
            return;
          }
          inp.value = get();
          inp.setAttribute('aria-invalid', 'true');
          setTimeout(() => inp.removeAttribute('aria-invalid'), 1200);
        });
        return h('label.rb-field', h('span', label), inp);
      };
      const panel = (title, ...children) => h('section.rb-panel', { 'aria-label': title }, h('div.rb-panel-body', children), h('div.rb-panel-title', title));
      const big = (ic, label, fn) => h('div.rb-lg-wrap', h('button.rb-lg', { type: 'button', onClick: fn, 'aria-label': label }, icon(ic, 30), h('span.rb-lg-label', label)));
      return h(
        'div.rb-scroller',
        panel(
          'Boundaries',
          big('hatch', 'Pick Points', () => app.focusCanvas()),
          big('select-all', 'Select', () => {
            app.cmdline.setValue('S');
            app.cmdline.submit();
          }),
          big('undo', 'Undo Last', () => {
            app.cmdline.setValue('U');
            app.cmdline.submit();
          }),
        ),
        panel('Pattern', gallery),
        panel(
          'Properties',
          h(
            'div.rb-fields',
            num('Scale', () => st.scale, (v) => (v > 0 ? void (st.scale = v) : false), {
              min: 0.001,
              step: 0.1,
            }),
            num(
              'Angle',
              () => +((st.angle * 180) / Math.PI).toFixed(4),
              (v) => void (st.angle = (v * Math.PI) / 180),
              { step: 15 },
            ),
          ),
        ),
        panel('Close', big('check', 'Close Hatch', () => app.cmdline.submit())),
      );
    },
  };
}
