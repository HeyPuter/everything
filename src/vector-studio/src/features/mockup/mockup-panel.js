/**
 * Mockup panel (Window > Mockup): make a mockup from the selection, then
 * fit the art (perspective corners or a free mesh, Detect Surface, Fit to
 * Photo), set how much of the photo's lighting shows on it and its opacity
 * and blending, and edit, release or expand it.
 */
import { h, announce } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { numberField, segmented, selectField } from '../../ui/widgets.js';
import { MESH_LIMIT } from '../envelope/envelope-model.js';
import { mockupParts, mockupCorners, lightingOf, setMockupCorners, setMockupFit, setMockupLighting, setMockupArtStyle, editingArt, LIGHTING_DEFAULTS } from './mockup-model.js';
import { singleMockup, makeTargets, effectiveFit, detectCommand, fitToPhoto } from './mockup-ui.js';
import { isConvexQuad } from './perspective.js';

const CORNERS = ['Top left', 'Top right', 'Bottom right', 'Bottom left'];

const BLENDS = [
  ['normal', 'Normal'],
  ['multiply', 'Multiply'],
  ['darken', 'Darken'],
  ['colorBurn', 'Color Burn'],
  ['overlay', 'Overlay'],
  ['softLight', 'Soft Light'],
  ['hardLight', 'Hard Light'],
  ['screen', 'Screen'],
  ['lighten', 'Lighten'],
  ['luminosity', 'Luminosity'],
].map(([value, label]) => ({ value, label }));

export class MockupPanel extends Panel {
  static id = 'mockup';
  static title = 'Mockup';
  static icon = 'mockup';

  menu() {
    return ['mockup.make', 'mockup.release', 'mockup.edit', '-', 'mockup.detect', { label: 'Fit Art to Photo', enabled: Boolean(singleMockup(this.editor)), run: () => fitToPhoto(this.app) }, '-', 'object.expand'];
  }

  /** One undoable change to the single mockup (scrubs coalesce). */
  edit(label, fn, live = false) {
    const ed = this.editor;
    const m = singleMockup(ed);
    if (!m) return;
    ed.doc.transact(label, () => fn(ed.doc, m), { coalesce: live ? `mockup-${m.id}-${label}` : null });
  }

  build() {
    const app = this.app;
    const btn = (label, iconName, onclick, cls = '') => h(`button.btn.small${cls}`, { type: 'button', onclick }, iconName ? icon(iconName, 14) : null, h('span', label));

    // Nothing to work on yet.
    this.makeBtn = btn('Make Mockup', 'mockup', () => app.commands.run('mockup.make'), '.primary');
    this.intro = h(
      'div.mockup-intro',
      h('div.mockup-intro-art', { 'aria-hidden': 'true' }, icon('mockup', 40)),
      h('p.mockup-intro-title', 'Put artwork on a photo'),
      h('p.mockup-intro-text', 'Select your artwork and a placed photo (File > Place), then make a mockup. The art bends onto the photo in perspective and picks up its lighting.'),
      this.makeBtn,
    );

    // Fit.
    this.fit = segmented(
      'Fit',
      [
        { value: 'perspective', label: 'Perspective: four corners', text: 'Perspective' },
        { value: 'mesh', label: 'Mesh: bend with Direct Selection', text: 'Mesh' },
      ],
      'perspective',
      (v) => this.edit(v === 'mesh' ? 'Mockup Mesh Fit' : 'Mockup Perspective Fit', (doc, m) => setMockupFit(doc, m.id, v, this.meshSize())),
    );
    this.fit.el.classList.add('mockup-fit');
    this.cornerFields = CORNERS.map((name, k) => {
      const field = (axis) =>
        numberField({
          label: axis.toUpperCase(),
          ariaLabel: `${name} corner ${axis.toUpperCase()}`,
          kind: 'length',
          unit: this.editor?.doc.root.units || 'pt',
          value: 0,
          width: '76px',
          onCommit: (v, o) =>
            this.edit(
              'Mockup Corner',
              (doc, m) => {
                const q = mockupCorners(doc, m);
                if (!q) return;
                q[k] = { ...q[k], [axis]: v };
                if (isConvexQuad(q)) setMockupCorners(doc, m.id, q);
                else app.notify('That corner would fold the surface over itself.', { polite: true });
              },
              Boolean(o?.live),
            ),
        });
      const x = field('x');
      const y = field('y');
      return { x, y, row: h('div.mockup-row', h('span.mockup-label', name), x.el, y.el) };
    });
    this.detectBtn = btn('Detect Surface', 'mockup-detect', () => this.detect());
    this.cornersBox = h('div.mockup-group', ...this.cornerFields.map((f) => f.row), h('div.quick-actions', this.detectBtn, btn('Fit to Photo', 'maximize', () => fitToPhoto(app))));
    const meshField = (label, key) =>
      numberField({
        label,
        kind: 'number',
        value: 4,
        min: 1,
        max: MESH_LIMIT,
        digits: 0,
        width: '56px',
        onCommit: (v) => this.edit('Mockup Mesh', (doc, m) => setMockupFit(doc, m.id, 'mesh', { ...this.meshSize(), [key]: Math.round(v) })),
      });
    this.rows = meshField('Rows', 'rows');
    this.cols = meshField('Columns', 'cols');
    this.meshBox = h('div.mockup-group', h('div.mockup-row', this.rows.el, this.cols.el), h('p.mockup-hint', 'Drag mesh points and handles with the Direct Selection tool to follow curved surfaces.'));

    // Lighting.
    const lightId = `mockup-light-${Math.random().toString(36).slice(2, 8)}`;
    this.lightOn = h('input', { type: 'checkbox', id: lightId });
    this.lightOn.addEventListener('change', () => this.edit('Mockup Lighting', (doc, m) => setMockupLighting(doc, m.id, { hidden: !this.lightOn.checked })));
    this.strength = numberField({
      label: 'Strength',
      kind: 'percent',
      value: LIGHTING_DEFAULTS.strength * 100,
      min: 0,
      max: 100,
      width: '64px',
      onCommit: (v, o) => this.edit('Mockup Lighting', (doc, m) => setMockupLighting(doc, m.id, { strength: v / 100, hidden: false }), Boolean(o?.live)),
    });
    this.displace = numberField({
      label: 'Texture',
      ariaLabel: 'Texture displacement',
      kind: 'length',
      value: 0,
      min: 0,
      max: 50,
      width: '64px',
      onCommit: (v, o) => this.edit('Mockup Texture', (doc, m) => setMockupLighting(doc, m.id, { displace: v, hidden: false }), Boolean(o?.live)),
    });
    this.lightBox = h(
      'div.mockup-group',
      h('label.mockup-check', { for: lightId }, this.lightOn, 'Take on the photo’s light and shadow'),
      h('div.mockup-row', this.strength.el, this.displace.el),
    );

    // Art appearance.
    this.opacity = numberField({
      label: 'Opacity',
      kind: 'percent',
      value: 100,
      min: 0,
      max: 100,
      width: '64px',
      onCommit: (v, o) => this.edit('Mockup Art Opacity', (doc, m) => setMockupArtStyle(doc, m.id, { opacity: v / 100 }), Boolean(o?.live)),
    });
    this.blend = selectField('Blending mode', BLENDS, 'normal', (v) => this.edit('Mockup Art Blending', (doc, m) => setMockupArtStyle(doc, m.id, { blendMode: v })));
    this.artBox = h('div.mockup-group', h('div.mockup-row', this.opacity.el, this.blend.el));

    this.editBtn = btn('Edit Art', 'pencil', () => app.commands.run('mockup.edit'));
    this.actions = h('div.quick-actions.mockup-actions', this.editBtn, btn('Release', 'ungroup', () => app.commands.run('mockup.release')), btn('Expand', 'layers', () => app.commands.run('object.expand')));

    this.status = h('p.mockup-status', { role: 'status', 'aria-live': 'polite' });
    this.main = h(
      'div.mockup-main',
      h('section.panel-section', h('h3.section-title', 'Fit'), this.fit.el, this.cornersBox, this.meshBox),
      h('section.panel-section', h('h3.section-title', 'Lighting'), this.lightBox),
      h('section.panel-section', h('h3.section-title', 'Art'), this.artBox, this.actions, this.status),
    );
    this.el.append(this.intro, this.main);
  }

  meshSize() {
    const m = singleMockup(this.editor);
    const mesh = m ? mockupParts(this.editor.doc, m).art?.live?.mesh : null;
    // A perspective mesh is finely divided; bending starts from a coarser grid.
    if (!m || !mesh || effectiveFit(this.editor.doc, m) === 'perspective') return { rows: 4, cols: 4 };
    return { rows: mesh.rows, cols: mesh.cols };
  }

  async detect() {
    this.detectBtn.disabled = true;
    this.status.textContent = 'Looking for a flat surface under the art...';
    try {
      await detectCommand(this.app);
      this.status.textContent = '';
      announce('Surface detected');
    } catch (err) {
      this.status.textContent = err.message || 'No surface was found.';
    } finally {
      this.detectBtn.disabled = false;
    }
  }

  update() {
    if (!this.built) return;
    const ed = this.editor;
    const m = singleMockup(ed);
    this.intro.hidden = Boolean(m);
    this.main.hidden = !m;
    if (!m) {
      this.makeBtn.disabled = !makeTargets(ed);
      return;
    }
    const doc = ed.doc;
    const { art } = mockupParts(doc, m);
    const fit = effectiveFit(doc, m);
    this.fit.set(fit);
    this.cornersBox.hidden = fit !== 'perspective';
    this.meshBox.hidden = fit !== 'mesh';
    const q = mockupCorners(doc, m);
    if (q) {
      this.cornerFields.forEach((f, k) => {
        f.x.setUnit(doc.root.units || 'pt');
        f.y.setUnit(doc.root.units || 'pt');
        f.x.set(q[k].x);
        f.y.set(q[k].y);
      });
    }
    const mesh = art?.live?.mesh;
    if (mesh) {
      this.rows.set(mesh.rows);
      this.cols.set(mesh.cols);
    }
    const light = lightingOf(art);
    this.lightOn.checked = Boolean(light && !light.hidden);
    this.strength.set((light?.strength ?? LIGHTING_DEFAULTS.strength) * 100);
    this.displace.setUnit(doc.root.units || 'pt');
    this.displace.set(light?.displace ?? 0);
    this.opacity.set((art?.opacity ?? 1) * 100);
    this.blend.set(art?.blendMode || 'normal');
    const editing = editingArt(doc, m);
    this.editBtn.querySelector('span').textContent = editing ? 'Finish Editing' : 'Edit Art';
    this.editBtn.setAttribute('aria-pressed', String(editing));
  }
}
