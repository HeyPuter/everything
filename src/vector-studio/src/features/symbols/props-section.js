/**
 * Properties panel section for selected symbol instances: which symbol
 * they show (choosing another replaces it), and Edit Symbol, Break Link,
 * Reset Transformation and Reset Colors.
 */
import { h } from '../../lib/dom.js';
import { iconButton } from '../../ui/widgets.js';
import { symbolDefs, getDef } from './model.js';
import { selectedInstances, replaceSymbol } from './commands.js';

export function symbolSection(app) {
  return {
    id: 'symbol',
    title: 'Symbol',
    when: (ed) => {
      const top = ed.topSelection();
      return top.length > 0 && top.every((id) => ed.doc.get(id)?.type === 'instance');
    },
    build: (a) => {
      const select = h('select.select.sym-props-select', { 'aria-label': 'Symbol' });
      select.addEventListener('change', () => {
        if (!select.value) return;
        try {
          replaceSymbol(a, select.value);
        } catch (err) {
          a.notify(err.message, { error: true });
        }
      });
      const kind = h('p.sym-props-kind');
      const edit = h('button.btn.small', { type: 'button', onclick: () => a.commands.run('symbol.edit') }, 'Edit Symbol');
      const breakLink = iconButton('symbol-break', 'Break Link to Symbol', () => a.commands.run('symbol.breakLink'), { className: 'small' });
      const reset = iconButton('refresh-cw', 'Reset Transformation', () => a.commands.run('symbol.reset'), { className: 'small' });
      const colors = h('button.btn.small', {
        type: 'button',
        onclick: () => {
          const ed = a.editor;
          const insts = selectedInstances(ed).filter((n) => n.overrides || n.tint || n.style);
          if (!insts.length) return;
          ed.doc.transact('Reset Symbol Colors', () => {
            for (const n of insts) ed.doc.update(n.id, { overrides: undefined, tint: undefined, style: undefined });
          });
        },
      }, 'Reset Colors');
      const el = h('div.sym-props', h('div.sym-props-row', select, breakLink, reset), kind, h('div.sym-props-row', edit, colors));
      const refresh = () => {
        const ed = a.editor;
        if (!ed) return;
        const insts = selectedInstances(ed, { sets: false });
        const ids = [...new Set(insts.map((n) => n.symbol))];
        const defs = symbolDefs(ed.doc);
        select.replaceChildren(
          ...(ids.length > 1 ? [h('option', { value: '', selected: true, disabled: true }, 'Mixed symbols')] : []),
          ...defs.map((d) => h('option', { value: d.id, selected: ids.length === 1 && ids[0] === d.id }, d.name)),
        );
        const def = ids.length === 1 ? getDef(ed.doc, ids[0]) : null;
        kind.textContent = def ? `${def.symbolDef.kind === 'static' ? 'Static' : 'Dynamic'} symbol${def.symbolDef.slice9 ? ' with 9-slice scaling' : ''}` : '';
        edit.disabled = insts.length !== 1;
        reset.disabled = !a.commands.isEnabled('symbol.reset');
        colors.disabled = !insts.some((n) => n.overrides || n.tint || n.style);
      };
      return { el, refresh };
    },
  };
}
