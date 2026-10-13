/**
 * Color Guide panel: a harmony built from a base color and a grid of
 * variations of each harmony color. Click a color to apply it to the
 * focused fill or stroke (Shift+click makes it the base). The base color
 * button takes the current color; the menus pick the harmony rule, the
 * kind of variation (tints and shades, warm and cool, vivid and muted) and
 * an optional swatch library to limit colors to. Save Group adds the
 * harmony to Swatches as a color group; Edit Colors recolors the selection
 * with the harmony. The panel menu holds the variation kinds, harmony
 * rules, library limit, base color, saving and Color Guide Options (steps
 * and variation amount, previewed live).
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { isHex, normalizeHex } from '../../lib/color.js';
import { setFocusedColor, focusedPaint, displayColor } from '../paint/ui-common.js';
import { addGroup, colorName } from '../paint/swatch-model.js';
import { HARMONY_RULES, VARIATIONS, ruleById, harmonyColors, variationRow, nearestColor } from './color-harmony.js';
import { paletteChoices } from './edit-commands.js';

export const GUIDE_DEFAULTS = { base: '#2f7de1', rule: 'complementary', variation: 'tints', steps: 4, amount: 100, limit: 'none' };

export function guideSettings(prefs) {
  const g = { ...GUIDE_DEFAULTS, ...(prefs.get('colorGuide') || {}) };
  if (!isHex(g.base)) g.base = GUIDE_DEFAULTS.base;
  g.rule = prefs.get('colorGuideRule') || g.rule;
  return g;
}

/** The colors the guide shows: { harmony: [hex], rows: [[hex]] }, limited to a palette when given. */
export function guideColors(g, palette = null) {
  const snap = (c) => (palette?.length ? nearestColor(c, palette) : c);
  const harmony = harmonyColors(normalizeHex(g.base), g.rule).map(snap);
  const rows = harmonyColors(normalizeHex(g.base), g.rule).map((c) => variationRow(c, g.variation, g.steps, g.amount).map(snap));
  return { harmony, rows };
}

export class ColorGuidePanel extends Panel {
  static id = 'colorGuide';
  static title = 'Color Guide';
  static icon = 'panel-color-guide';
  static placement = 'strip';
  static shortcut = 'Shift+F3';

  build() {
    const app = this.app;
    this.baseBtn = h('button.cg-base', { type: 'button', 'data-tip': 'Set Base Color to the Current Color', 'aria-label': 'Set base color to the current color', onclick: () => this.takeCurrent() });
    this.strip = h('div.cg-strip', { role: 'group', 'aria-label': 'Harmony colors' });
    this.rule = h(
      'select.select.cg-rule',
      { 'aria-label': 'Harmony rule', onchange: () => this.setRule(this.rule.value) },
      HARMONY_RULES.map((r) => h('option', { value: r.id }, r.label)),
    );
    this.variation = h(
      'select.select.cg-var',
      { 'aria-label': 'Variations', onchange: () => this.set({ variation: this.variation.value }) },
      VARIATIONS.map((v) => h('option', { value: v.id }, v.label)),
    );
    this.leftLabel = h('span.cg-side');
    this.rightLabel = h('span.cg-side.right');
    this.grid = h('div.cg-grid', { role: 'grid', 'aria-label': 'Color variations' });
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    this.steps = h('input#cg-steps.cg-steps', { type: 'number', min: 1, max: 7, step: 1, onchange: () => this.set({ steps: Math.max(1, Math.min(7, Math.round(Number(this.steps.value) || 4))) }) });
    this.amount = h('input#cg-amount', { type: 'range', min: 10, max: 100, step: 5, 'aria-label': 'Variation amount', onchange: () => this.set({ amount: Number(this.amount.value) }) });
    this.limit = h('select.select.cg-limit', { 'aria-label': 'Limit colors to a swatch library', onchange: () => this.set({ limit: this.limit.value }) });
    this.empty = h('p.panel-empty', 'Open a document to use the Color Guide.');
    this.el.append(
      h('div.cg-top', this.baseBtn, this.strip),
      h('div.cg-row', this.rule),
      h('div.cg-row', this.variation),
      h('div.cg-labels', this.leftLabel, this.rightLabel),
      this.grid,
      h(
        'details.cg-options',
        h('summary', 'Options'),
        h('div.cg-opt-row', h('label', { for: 'cg-steps' }, 'Steps'), this.steps),
        h('div.cg-opt-row', h('label', { for: 'cg-amount' }, 'Variation'), this.amount),
        h('div.cg-opt-row', h('span', 'Limit To'), this.limit),
      ),
      h(
        'div.cg-footer',
        iconButton('swatch-book', 'Save Color Group to Swatches', () => this.saveGroup(), { className: 'small' }),
        iconButton('palette', 'Edit or Apply Colors (Recolor with Harmony)', () => app.commands.run('color.preset.harmony'), { className: 'small' }),
      ),
    );
    this.focus = { r: 0, c: 0 };
  }

  menu() {
    const app = this.app;
    const g = this.settings;
    const ed = app.editor;
    const choices = ed ? paletteChoices(ed.doc) : [];
    return [
      ...VARIATIONS.map((v) => ({ label: `Show ${v.label}`, checked: g.variation === v.id, run: () => this.set({ variation: v.id }) })),
      '-',
      { label: 'Harmony Rules', submenu: HARMONY_RULES.map((r) => ({ label: r.label, checked: g.rule === r.id, run: () => this.setRule(r.id) })) },
      {
        label: 'Limit Colors to Swatch Library',
        submenu: [{ label: 'None', checked: g.limit === 'none', run: () => this.set({ limit: 'none' }) }, ...choices.map((c) => ({ label: c.name, checked: g.limit === c.id, run: () => this.set({ limit: c.id }) }))],
      },
      '-',
      { label: 'Set Base Color to Current Color', enabled: Boolean(ed), run: () => this.takeCurrent() },
      { label: 'Save Colors as Swatches', enabled: Boolean(ed), run: () => this.saveGroup() },
      { label: 'Edit or Apply Colors...', enabled: app.commands.isEnabled('color.preset.harmony'), run: () => app.commands.run('color.preset.harmony') },
      '-',
      { label: 'Color Guide Options...', run: () => this.optionsDialog() },
    ];
  }

  setRule(id) {
    this.app.prefs.set('colorGuideRule', id);
    this.render();
  }

  /** Steps and variation amount, previewed in the panel while the dialog is open. */
  async optionsDialog() {
    const before = { steps: this.settings.steps, amount: this.settings.amount };
    const clampSteps = (v) => Math.max(1, Math.min(7, Math.round(Number(v) || before.steps)));
    const res = await this.app.dialogs.form({
      title: 'Color Guide Options',
      fields: [
        { key: 'steps', label: 'Steps (each side)', type: 'number', value: before.steps, min: 1, max: 7 },
        { key: 'amount', label: 'Variation', type: 'range', value: before.amount, min: 10, max: 100, step: 5 },
      ],
      onChange: (v) => this.set({ steps: clampSteps(v.steps), amount: Number(v.amount) || before.amount }),
    });
    if (!res) this.set(before);
    else this.set({ steps: clampSteps(res.steps), amount: Number(res.amount) || before.amount });
  }

  get settings() {
    return guideSettings(this.app.prefs);
  }

  set(patch) {
    const g = { ...this.settings, ...patch };
    delete g.rule;
    this.app.prefs.set('colorGuide', g);
    this.render();
  }

  palette() {
    const g = this.settings;
    if (g.limit === 'none' || !this.app.editor) return null;
    return paletteChoices(this.app.editor.doc).find((p) => p.id === g.limit)?.colors || null;
  }

  takeCurrent() {
    const ed = this.app.editor;
    if (!ed) return;
    const { key, paint } = focusedPaint(ed);
    this.setBase(displayColor(ed, key, paint));
  }

  setBase(hex) {
    this.set({ base: normalizeHex(hex) });
    this.app.notify(`Base color ${hex.toUpperCase()}.`, { polite: true });
  }

  apply(hex, e) {
    const ed = this.app.editor;
    if (!ed) return;
    if (e?.shiftKey) return this.setBase(hex);
    setFocusedColor(ed, hex, null, { forceSolid: true });
  }

  saveGroup() {
    const ed = this.app.editor;
    if (!ed) return;
    const { harmony } = guideColors(this.settings, this.palette());
    const rule = ruleById(this.settings.rule);
    const doc = ed.doc;
    doc.transact('New Color Group', () => addGroup(doc, `${rule.label} Group`, { paints: [...new Set(harmony)].map((c) => ({ name: colorName(c), paint: { type: 'solid', color: c } })) }));
    this.app.notify(`Added a ${rule.label} color group to Swatches.`, { polite: true });
  }

  update() {
    this.el.classList.toggle('disabled', !this.app.editor);
    this.render();
  }

  render() {
    const g = this.settings;
    const ed = this.app.editor;
    // Limit choices depend on the document's swatches.
    const choices = ed ? paletteChoices(ed.doc) : [];
    const limitKey = choices.map((c) => c.id).join('|');
    if (this.limitKey !== limitKey) {
      this.limitKey = limitKey;
      this.limit.replaceChildren(h('option', { value: 'none' }, 'None'), ...choices.map((c) => h('option', { value: c.id }, c.name)));
    }
    this.limit.value = choices.some((c) => c.id === g.limit) ? g.limit : 'none';
    this.rule.value = g.rule;
    this.variation.value = g.variation;
    if (document.activeElement !== this.steps) this.steps.value = String(g.steps);
    this.amount.value = String(g.amount);
    const v = VARIATIONS.find((x) => x.id === g.variation) || VARIATIONS[0];
    this.leftLabel.textContent = v.left;
    this.rightLabel.textContent = v.right;
    const renderKey = JSON.stringify([g, this.palette()?.length]);
    this.baseBtn.style.background = g.base;
    if (renderKey === this.renderKey) return;
    this.renderKey = renderKey;
    const { harmony, rows } = guideColors(g, this.palette());
    const swatch = (c, label) => h('button.cg-cell', { type: 'button', style: { background: c }, 'aria-label': `${label} ${c.toUpperCase()}`, 'data-tip': `${c.toUpperCase()} (Shift+click: make base color)`, tabindex: '-1', onclick: (e) => this.apply(c, e) });
    this.strip.replaceChildren(
      ...harmony.map((c, i) => {
        const b = swatch(c, i === 0 ? 'Base color' : `Harmony color ${i + 1}`);
        b.tabIndex = 0;
        return b;
      }),
    );
    const cols = rows[0]?.length || 0;
    this.grid.style.setProperty('--cg-cols', String(cols));
    this.grid.replaceChildren(
      ...rows.map((row, r) =>
        h(
          'div.cg-grid-row',
          { role: 'row' },
          row.map((c, i) => {
            const cell = swatch(c, `Row ${r + 1}, ${i < g.steps ? v.left.toLowerCase() : i > g.steps ? v.right.toLowerCase() : 'harmony color'}`);
            cell.setAttribute('role', 'gridcell');
            cell.classList.toggle('center', i === g.steps);
            cell.dataset.r = String(r);
            cell.dataset.c = String(i);
            return cell;
          }),
        ),
      ),
    );
    this.focus = { r: Math.min(this.focus.r, rows.length - 1), c: Math.min(this.focus.c, cols - 1) };
    this.cellAt(this.focus.r, this.focus.c)?.setAttribute('tabindex', '0');
  }

  cellAt(r, c) {
    return this.grid.querySelector(`[data-r="${r}"][data-c="${c}"]`);
  }

  onKey(e) {
    const rows = this.grid.querySelectorAll('.cg-grid-row').length;
    const cols = Number(this.grid.style.getPropertyValue('--cg-cols')) || 0;
    const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    this.cellAt(this.focus.r, this.focus.c)?.setAttribute('tabindex', '-1');
    this.focus = { r: Math.max(0, Math.min(rows - 1, this.focus.r + d[0])), c: Math.max(0, Math.min(cols - 1, this.focus.c + d[1])) };
    const cell = this.cellAt(this.focus.r, this.focus.c);
    cell?.setAttribute('tabindex', '0');
    cell?.focus();
  }
}
