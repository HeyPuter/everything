/**
 * Align panel (Shift+F7): Align Objects, Distribute Objects, Distribute
 * Spacing (with a spacing value when aligning to a key object) and Align
 * To (Selection, Key Object, Artboard). The key object is set by clicking
 * an already-selected object with the Selection tool; it gets a thick
 * outline. Runs the shared align.* / distribute.* commands.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton, numberField, selectField } from '../../ui/widgets.js';

const ALIGN = [
  ['align.left', 'align-left', 'Horizontal Align Left'],
  ['align.hcenter', 'align-hcenter', 'Horizontal Align Center'],
  ['align.right', 'align-right', 'Horizontal Align Right'],
  ['align.top', 'align-top', 'Vertical Align Top'],
  ['align.vcenter', 'align-vcenter', 'Vertical Align Center'],
  ['align.bottom', 'align-bottom', 'Vertical Align Bottom'],
];
const DISTRIBUTE = [
  ['distribute.top', 'distribute-top', 'Vertical Distribute Top'],
  ['distribute.vcenter', 'distribute-vcenter', 'Vertical Distribute Center'],
  ['distribute.bottom', 'distribute-bottom', 'Vertical Distribute Bottom'],
  ['distribute.left', 'distribute-left', 'Horizontal Distribute Left'],
  ['distribute.hcenter', 'distribute-hcenter', 'Horizontal Distribute Center'],
  ['distribute.right', 'distribute-right', 'Horizontal Distribute Right'],
];
const SPACING = [
  ['distribute.vspace', 'distribute-vspace', 'Vertical Distribute Space'],
  ['distribute.hspace', 'distribute-hspace', 'Horizontal Distribute Space'],
];

/** Current Align To target: 'selection' | 'key' | 'artboard'. */
export function alignTarget(app) {
  if (app.alignKey && app.editor?.selection.has(app.alignKey)) return 'key';
  return app.alignTo === 'artboard' ? 'artboard' : 'selection';
}

/** Make `id` the key object (or clear it with null). */
export function setKeyObject(app, id) {
  app.alignKey = id || null;
  app.editor?.emit('overlay');
  app.dock?.update();
}

export class AlignPanel extends Panel {
  static id = 'align';
  static title = 'Align';
  static icon = 'align-hcenter';
  static placement = 'strip';
  static shortcut = 'Shift+F7';

  menu() {
    const app = this.app;
    const target = alignTarget(app);
    const showing = this.showOptions;
    return [
      { label: showing ? 'Hide Options' : 'Show Options', run: () => this.setShowOptions(!showing) },
      '-',
      { label: 'Use Preview Bounds', checked: Boolean(app.prefs.get('previewBounds')), run: () => this.setPreviewBounds(!app.prefs.get('previewBounds')) },
      '-',
      { label: 'Align to Selection', checked: target === 'selection', run: () => this.setTarget('selection') },
      { label: 'Align to Key Object', checked: target === 'key', enabled: Boolean(app.editor?.selection.size), run: () => this.setTarget('key') },
      { label: 'Align to Artboard', checked: target === 'artboard', run: () => this.setTarget('artboard') },
      '-',
      { label: 'Cancel Key Object', enabled: target === 'key', run: () => this.setTarget('selection') },
    ];
  }

  get showOptions() {
    return this.app.prefs.get('alignShowOptions') !== false;
  }

  setShowOptions(on) {
    this.app.prefs.set('alignShowOptions', on);
    this.update();
  }

  setPreviewBounds(on) {
    this.app.prefs.set('previewBounds', on);
    this.app.editor?.emit('selection');
    this.update();
  }

  build() {
    const app = this.app;
    this.spacingValue = 0;
    const btn = ([cmd, ic, label]) => {
      const b = iconButton(ic, label, () => this.run(cmd));
      b.dataset.cmd = cmd;
      return b;
    };
    this.alignBtns = ALIGN.map(btn);
    this.distBtns = DISTRIBUTE.map(btn);
    this.spaceBtns = SPACING.map(btn);
    this.spacing = numberField({ label: 'Spacing', ariaLabel: 'Distribute spacing', value: 0, unit: 'pt', min: 0, width: '72px', onCommit: (v) => (this.spacingValue = v) });
    this.alignTo = selectField(
      'Align To',
      [
        { value: 'selection', label: 'Align to Selection' },
        { value: 'key', label: 'Align to Key Object' },
        { value: 'artboard', label: 'Align to Artboard' },
      ],
      'selection',
      (v) => this.setTarget(v),
    );
    const prevId = `align-prev-${Math.random().toString(36).slice(2, 7)}`;
    this.preview = h('input', { type: 'checkbox', id: prevId, onchange: () => app.prefs.set('previewBounds', this.preview.checked) });
    this.keyNote = h('p.align-note', { 'aria-live': 'polite' });
    // Distribute Spacing and Align To are the options Show/Hide Options toggles.
    this.optionSections = [
      section('Distribute Spacing', h('div.icon-row.align-spacing', this.spaceBtns, this.spacing.el)),
      section('Align To', h('div.align-to', this.alignTo.el), this.keyNote, h('div.check-row', this.preview, h('label', { for: prevId }, 'Use Preview Bounds'))),
    ];
    this.el.append(section('Align Objects', h('div.icon-row', this.alignBtns)), section('Distribute Objects', h('div.icon-row', this.distBtns)), ...this.optionSections);
  }

  setTarget(v) {
    const app = this.app;
    const ed = app.editor;
    if (v === 'key') {
      // Without a key yet, the frontmost selected object becomes the key.
      if (!(app.alignKey && ed?.selection.has(app.alignKey))) {
        const top = ed?.topSelection();
        if (top?.length) setKeyObject(app, top[top.length - 1]);
      }
      app.alignTo = 'selection';
    } else {
      setKeyObject(app, null);
      app.alignTo = v;
    }
    this.update();
  }

  async run(cmd) {
    const app = this.app;
    const key = alignTarget(app) === 'key';
    const isSpacing = cmd === 'distribute.hspace' || cmd === 'distribute.vspace';
    app.distributeSpacing = isSpacing && key ? this.spacingValue : null;
    try {
      await app.commands.run(cmd);
    } finally {
      app.distributeSpacing = null;
    }
  }

  update() {
    const app = this.app;
    const ed = app.editor;
    const n = ed ? ed.topSelection().length : 0;
    const target = alignTarget(app);
    this.alignTo.set(target);
    for (const b of this.alignBtns) b.disabled = !n;
    for (const b of this.distBtns) b.disabled = n < 3;
    for (const b of this.spaceBtns) b.disabled = target === 'key' ? n < 2 : n < 3;
    this.spacing.input.disabled = target !== 'key';
    this.spacing.setUnit(ed?.doc.root.units || 'pt');
    this.spacing.set(this.spacingValue);
    this.preview.checked = Boolean(app.prefs.get('previewBounds'));
    for (const s of this.optionSections) s.hidden = !this.showOptions;
    if (target === 'key') this.keyNote.textContent = 'Click a selected object to change the key object.';
    else if (n > 1) this.keyNote.textContent = 'Tip: click a selected object to make it the key object.';
    else this.keyNote.textContent = '';
  }
}

function section(title, ...children) {
  return h('section.panel-section', h('h3.section-title', title), ...children);
}
