/**
 * Pathfinder panel (strip) and the Pathfinder section of the Properties
 * panel. Button rows are ARIA toolbars with roving tabindex: Left/Right
 * (and Up/Down) move between buttons, Home/End jump to the ends.
 * Alt-clicking a shape mode makes a live compound shape (see
 * pathfinder-extras.js); Expand bakes it.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { formatShortcut } from '../../commands/registry.js';
import { SHAPE_MODES, PATHFINDERS, canRun, operands } from './pathfinder.js';
import { selectedCompoundShapes, compoundShapeMode } from './pathfinder-extras.js';

/** An ARIA toolbar of icon buttons with roving tabindex. */
export function buttonRow(label, buttons) {
  const row = h('div.icon-row.pf-row', { role: 'toolbar', 'aria-label': label });
  buttons.forEach((b, i) => {
    b.tabIndex = i === 0 ? 0 : -1;
    row.append(b);
  });
  row.addEventListener('keydown', (e) => {
    const items = [...row.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    items[i].tabIndex = -1;
    items[j].tabIndex = 0;
    items[j].focus();
  });
  return row;
}

function kindButton(app, def, size = 18) {
  const cmd = `pathfinder.${def.kind}`;
  const mode = SHAPE_MODES.includes(def);
  // Alt-click on a shape mode: a live compound shape instead of a one-time result.
  const b = iconButton(def.icon, def.label, (e) => (mode && e?.altKey ? app.commands.run('pathfinder.makeCompoundShape', { kind: def.kind }) : app.commands.run(cmd)), { size, className: 'pf-btn' });
  b.dataset.kind = def.kind;
  if (mode) b.setAttribute('aria-description', 'Alt-click for a live compound shape');
  return b;
}

function refreshButtons(app, root) {
  const ed = app.editor;
  const shapes = selectedCompoundShapes(ed);
  const mode = shapes.length === 1 ? compoundShapeMode(shapes[0]) : null;
  for (const b of root.querySelectorAll('[data-kind]')) {
    const isMode = SHAPE_MODES.some((m) => m.kind === b.dataset.kind);
    // A selected compound shape: its shape mode shows pressed; the others switch it.
    b.disabled = !canRun(ed, b.dataset.kind) && !(isMode && shapes.length);
    if (isMode) b.setAttribute('aria-pressed', String(mode === b.dataset.kind));
  }
}

export class PathfinderPanel extends Panel {
  static id = 'pathfinder';
  static title = 'Pathfinder';
  static icon = 'pathfinder-unite';
  static placement = 'strip';
  static shortcut = 'Shift+Mod+F9';

  menu() {
    return ['pathfinder.trap', 'path.repeatPathfinder', 'pathfinder.options', '-', 'pathfinder.makeCompoundShape', 'pathfinder.releaseCompoundShape', 'pathfinder.expandCompoundShape'];
  }

  build() {
    const app = this.app;
    const modes = buttonRow('Shape Modes', SHAPE_MODES.map((d) => kindButton(app, d, 20)));
    this.expandBtn = h('button.btn.small.pf-expand', { type: 'button', onclick: () => app.commands.run('pathfinder.expandCompoundShape') }, 'Expand');
    const finders = buttonRow('Pathfinders', PATHFINDERS.map((d) => kindButton(app, d, 20)));
    this.repeat = h('button.btn.small', { type: 'button', onclick: () => app.commands.run('path.repeatPathfinder') }, 'Repeat');
    const options = h('button.btn.small', { type: 'button', onclick: () => app.commands.run('pathfinder.options') }, 'Pathfinder Options...');
    this.status = h('p.pf-status', { 'aria-live': 'polite' });
    this.el.append(
      h('h3.pf-label', 'Shape Modes:'),
      h('div.pf-modes', modes, this.expandBtn),
      h('h3.pf-label', 'Pathfinders:'),
      finders,
      h('div.pf-actions', this.repeat, options),
      this.status,
    );
  }

  update() {
    const app = this.app;
    refreshButtons(app, this.el);
    const last = app.lastPathfinder;
    this.repeat.disabled = !last || !canRun(app.editor, last);
    const label = [...SHAPE_MODES, ...PATHFINDERS].find((k) => k.kind === last)?.label;
    this.repeat.textContent = label ? `Repeat ${label}` : 'Repeat';
    this.repeat.title = `${this.repeat.textContent} (${formatShortcut('Mod+4')})`;
    const n = app.editor ? operands(app.editor).length : 0;
    const shapes = selectedCompoundShapes(app.editor);
    this.expandBtn.disabled = !shapes.length;
    if (shapes.length) {
      const mode = SHAPE_MODES.find((m) => m.kind === compoundShapeMode(shapes[0]))?.label;
      this.status.textContent = shapes.length === 1 && mode ? `Compound shape: ${mode}` : `${shapes.length} compound shapes selected`;
    } else this.status.textContent = n >= 2 ? `${n} paths selected` : 'Select two or more paths. Alt-click a shape mode for a live compound shape.';
  }
}

/** Properties panel section: the four shape modes plus a button that opens the panel. */
export const pathfinderSection = {
  id: 'pathfinder',
  title: 'Pathfinder',
  when: (editor) => operands(editor).length >= 2,
  build(app) {
    const more = iconButton('ellipsis', 'More Pathfinder options', () => app.openPanel('pathfinder'), { className: 'pf-more' });
    more.setAttribute('aria-haspopup', 'dialog');
    const row = buttonRow('Shape Modes', [...SHAPE_MODES.map((d) => kindButton(app, d, 18)), more]);
    const el = h('div.pf-props', row);
    return { el, refresh: () => refreshButtons(app, el) };
  },
};
