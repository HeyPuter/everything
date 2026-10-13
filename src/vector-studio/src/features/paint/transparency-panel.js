/**
 * Transparency panel (Shift+Cmd+F10): blending mode, opacity, opacity
 * masks (object and mask thumbnails with the link between them, Make /
 * Release Mask, Clip, Invert Mask), and the options Isolate Blending,
 * Knockout Group and Opacity & Mask Define Knockout Shape. Unlike fill and
 * stroke, these apply to the selected objects themselves (a selected group
 * gets the opacity as a whole, so its children do not show through each
 * other). The panel menu shows or hides the thumbnails and options, makes,
 * releases, disables or unlinks masks, and sets how new masks start.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { numberField, selectField, iconButton } from '../../ui/widgets.js';
import { BLEND_MODES } from '../../render/draw.js';
import { BLEND_LABELS } from '../../ui/panels/properties.js';
import { gestureKey } from './ui-common.js';
import { icon } from '../../ui/icons.js';
import { drawThumbnail } from './thumbs.js';
import { maskedTargets, maskFlag, maskRootNode, maskView, canMakeMask, makeOpacityMask, releaseOpacityMask, setMaskFlag } from './opacity-mask.js';

/** Objects that carry opacity/blending: the top-level selection (any type). */
export function transparencyTargets(editor) {
  return editor.topSelection().map((id) => editor.doc.get(id)).filter((n) => n && n.type !== 'layer');
}

export function commonTop(editor, key, dflt) {
  const nodes = transparencyTargets(editor);
  if (!nodes.length) return editor.style[key] ?? dflt;
  const first = nodes[0][key] ?? dflt;
  return nodes.every((n) => (n[key] ?? dflt) === first) ? first : 'mixed';
}

/** Set a transparency attribute on the selected objects (and the current style). */
export function setTransparency(editor, patch, label, coalesce = null) {
  const nodes = transparencyTargets(editor);
  const stylePatch = {};
  if ('opacity' in patch) stylePatch.opacity = patch.opacity;
  if ('blendMode' in patch) stylePatch.blendMode = patch.blendMode;
  if (Object.keys(stylePatch).length) editor.setStyle(stylePatch);
  if (!nodes.length) return;
  editor.doc.transact(
    label,
    () => {
      for (const n of nodes) {
        const p = { ...patch };
        if (n.type !== 'group' && n.type !== 'layer') {
          delete p.isolate;
          delete p.knockout;
        }
        // Defining the knockout shape is a setting of objects inside a knockout group.
        if (!(n.parent && editor.doc.get(n.parent)?.knockout)) delete p.knockoutShape;
        if (Object.keys(p).length) editor.doc.update(n.id, p);
      }
    },
    { coalesce },
  );
}

/** Mask commands, shared by the panel menu, its buttons and the command palette. */
export function registerTransparencyCommands(app) {
  const ed = (a) => a.editor;
  const masked = (a) => Boolean(a.editor && maskedTargets(a.editor).length);
  app.commands.register([
    {
      id: 'transparency.makeMask',
      label: 'Make Opacity Mask',
      enabled: (a) => canMakeMask(ed(a)),
      run: (a) => makeOpacityMask(ed(a), { clip: a.prefs.get('newMasksClip') !== false, invert: Boolean(a.prefs.get('newMasksInvert')) }),
    },
    { id: 'transparency.releaseMask', label: 'Release Opacity Mask', enabled: masked, run: (a) => releaseOpacityMask(ed(a)) },
    {
      id: 'transparency.toggleMask',
      label: (a) => (a.editor && maskFlag(a.editor, 'disabled') === true ? 'Enable Opacity Mask' : 'Disable Opacity Mask'),
      enabled: masked,
      run: (a) => {
        const off = maskFlag(ed(a), 'disabled') === true;
        setMaskFlag(ed(a), 'disabled', !off, off ? 'Enable Opacity Mask' : 'Disable Opacity Mask');
      },
    },
    {
      id: 'transparency.toggleMaskLink',
      label: (a) => (a.editor && maskFlag(a.editor, 'unlinked') === true ? 'Link Opacity Mask' : 'Unlink Opacity Mask'),
      enabled: masked,
      run: (a) => {
        const un = maskFlag(ed(a), 'unlinked') === true;
        setMaskFlag(ed(a), 'unlinked', !un, un ? 'Link Opacity Mask' : 'Unlink Opacity Mask');
      },
    },
    {
      id: 'transparency.maskClip',
      label: 'Clip Opacity Mask',
      enabled: masked,
      checked: (a) => Boolean(a.editor) && maskFlag(a.editor, 'clip') === true,
      run: (a) => setMaskFlag(ed(a), 'clip', maskFlag(ed(a), 'clip') !== true, 'Clip Opacity Mask'),
    },
    {
      id: 'transparency.maskInvert',
      label: 'Invert Opacity Mask',
      enabled: masked,
      checked: (a) => Boolean(a.editor) && maskFlag(a.editor, 'invert') === true,
      run: (a) => setMaskFlag(ed(a), 'invert', maskFlag(ed(a), 'invert') !== true, 'Invert Opacity Mask'),
    },
  ]);
}

export class TransparencyPanel extends Panel {
  static id = 'transparency';
  static title = 'Transparency';
  static icon = 'contrast';
  static placement = 'strip';
  static shortcut = 'Shift+Mod+F10';

  build() {
    const app = this.app;
    this.key = gestureKey('opacity');
    this.blend = selectField('Blending mode', BLEND_MODES.map((m) => ({ value: m, label: BLEND_LABELS[m] || m })), 'normal', (v) => app.editor && setTransparency(app.editor, { blendMode: v }, 'Blending Mode'));
    this.opacity = numberField({
      label: 'Opacity',
      kind: 'percent',
      value: 100,
      min: 0,
      max: 100,
      width: '64px',
      onCommit: (v, o) => {
        if (!o?.live) this.key = gestureKey('opacity');
        if (app.editor) setTransparency(app.editor, { opacity: v / 100 }, 'Opacity', this.key);
      },
    });
    this.range = h('input.tp-range', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Opacity slider' });
    this.range.addEventListener('pointerdown', () => (this.key = gestureKey('opacity')));
    this.range.addEventListener('keydown', (e) => {
      this.key = gestureKey('opacity');
      e.stopPropagation();
    });
    this.range.addEventListener('input', () => app.editor && setTransparency(app.editor, { opacity: Number(this.range.value) / 100 }, 'Opacity', this.key));
    const check = (id, label, onchange) => {
      const input = h('input', { type: 'checkbox', id, onchange: () => onchange(input.checked) });
      return { input, el: h('div.check-row', input, h('label', { for: id }, label)) };
    };
    const attr = (key, label) => (on) => app.editor && setTransparency(app.editor, { [key]: on || undefined }, label);
    this.isolate = check('tp-isolate', 'Isolate Blending', attr('isolate', 'Isolate Blending'));
    this.knockout = check('tp-knockout', 'Knockout Group', attr('knockout', 'Knockout Group'));
    this.knockShape = check('tp-knockshape', 'Opacity & Mask Define Knockout Shape', attr('knockoutShape', 'Opacity & Mask Define Knockout Shape'));
    this.clip = check('tp-clip', 'Clip', () => app.commands.run('transparency.maskClip'));
    this.invert = check('tp-invert', 'Invert Mask', () => app.commands.run('transparency.maskInvert'));

    // Thumbnails: the object, the link between object and mask, and the mask.
    this.thumb = h('canvas.tp-thumb', { width: 48, height: 48, 'aria-hidden': 'true' });
    this.maskThumb = h('canvas.tp-thumb', { width: 48, height: 48, 'aria-hidden': 'true' });
    this.maskBtn = h(
      'button.tp-mask-thumb',
      {
        type: 'button',
        'data-tip': 'Opacity mask (Shift+click to disable or enable it)',
        onclick: (e) => {
          if (e.shiftKey) app.commands.run('transparency.toggleMask');
          else if (!maskedTargets(app.editor).length) app.commands.run('transparency.makeMask');
        },
      },
      this.maskThumb,
    );
    this.linkBtn = iconButton('link', 'Link opacity mask to artwork', () => app.commands.run('transparency.toggleMaskLink'), { className: 'small tp-link' });
    this.makeBtn = h('button.btn.small.tp-make', { type: 'button', onclick: () => app.commands.run(maskedTargets(app.editor).length ? 'transparency.releaseMask' : 'transparency.makeMask') }, 'Make Mask');
    this.thumbs = h(
      'div.tp-mid',
      h('div.tp-thumbs', this.thumb, this.linkBtn, this.maskBtn),
      h('div.tp-checks', this.makeBtn, this.clip.el, this.invert.el),
    );
    this.options = h('div.tp-options', this.isolate.el, this.knockout.el, this.knockShape.el);
    this.note = h('p.tp-note.muted', 'Select two or more objects to make an opacity mask: the top one masks the rest.');
    this.el.append(h('div.tp-top', this.blend.el, this.opacity.el), this.range, this.thumbs, this.note, this.options);
    this.setShown('thumbs', app.prefs.get('transparencyThumbs') !== false);
    this.setShown('options', app.prefs.get('transparencyOptions') !== false);
  }

  setShown(which, on) {
    if (which === 'thumbs') {
      this.thumbsShown = on;
      this.app.prefs.set('transparencyThumbs', on);
      this.thumbs.hidden = !on;
    } else {
      this.optionsShown = on;
      this.app.prefs.set('transparencyOptions', on);
      this.options.hidden = !on;
    }
    if (this.visible) this.update();
  }

  menu() {
    const app = this.app;
    return [
      { label: this.thumbsShown ? 'Hide Thumbnails' : 'Show Thumbnails', run: () => this.setShown('thumbs', !this.thumbsShown) },
      { label: this.optionsShown ? 'Hide Options' : 'Show Options', run: () => this.setShown('options', !this.optionsShown) },
      '-',
      'transparency.makeMask',
      'transparency.releaseMask',
      'transparency.toggleMask',
      'transparency.toggleMaskLink',
      '-',
      { label: 'New Opacity Masks Are Clipping', checked: app.prefs.get('newMasksClip') !== false, run: () => app.prefs.set('newMasksClip', app.prefs.get('newMasksClip') === false) },
      { label: 'New Opacity Masks Are Inverted', checked: Boolean(app.prefs.get('newMasksInvert')), run: () => app.prefs.set('newMasksInvert', !app.prefs.get('newMasksInvert')) },
    ];
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    if (!ed) return;
    const bm = commonTop(ed, 'blendMode', 'normal');
    this.blend.set(bm === 'mixed' ? '' : bm);
    const op = commonTop(ed, 'opacity', 1);
    this.opacity.set(op === 'mixed' ? 'mixed' : op * 100);
    if (document.activeElement !== this.range) this.range.value = String(op === 'mixed' ? 100 : Math.round(op * 100));
    const sel = transparencyTargets(ed);
    const groups = sel.filter((n) => n.type === 'group');
    const inKnockout = sel.filter((n) => n.parent && ed.doc.get(n.parent)?.knockout);
    const setCheck = (c, nodes, key) => {
      c.input.disabled = !nodes.length;
      const vals = nodes.map((g) => Boolean(g[key]));
      c.input.checked = vals.length > 0 && vals.every(Boolean);
      c.input.indeterminate = vals.some(Boolean) && !vals.every(Boolean);
    };
    setCheck(this.isolate, groups, 'isolate');
    setCheck(this.knockout, groups, 'knockout');
    setCheck(this.knockShape, inKnockout, 'knockoutShape');
    this.isolate.el.title = groups.length ? '' : 'Applies to groups';
    this.knockShape.el.title = inKnockout.length ? '' : 'Applies to objects inside a knockout group';

    // Opacity mask state.
    const masked = maskedTargets(ed);
    const hasMask = masked.length > 0;
    for (const [c, key] of [[this.clip, 'clip'], [this.invert, 'invert']]) {
      const v = maskFlag(ed, key);
      c.input.disabled = !hasMask;
      c.input.checked = v === true;
      c.input.indeterminate = v === 'mixed';
    }
    this.makeBtn.textContent = hasMask ? 'Release' : 'Make Mask';
    this.makeBtn.disabled = !hasMask && !canMakeMask(ed);
    this.makeBtn.setAttribute('aria-label', hasMask ? 'Release Opacity Mask' : 'Make Opacity Mask');
    const linked = maskFlag(ed, 'unlinked') !== true;
    this.linkBtn.hidden = !hasMask;
    this.linkBtn.setAttribute('aria-pressed', String(hasMask && linked));
    this.linkBtn.replaceChildren(icon(linked ? 'link' : 'unlink', 14));
    const linkLabel = linked ? 'Opacity mask is linked to the artwork (click to unlink)' : 'Opacity mask is unlinked (click to link)';
    this.linkBtn.setAttribute('aria-label', linkLabel);
    this.linkBtn.dataset.tip = linkLabel;
    const disabled = maskFlag(ed, 'disabled') === true;
    this.maskBtn.classList.toggle('mask-off', disabled);
    this.maskBtn.classList.toggle('empty', !hasMask);
    this.maskBtn.setAttribute('aria-label', hasMask ? `Opacity mask${disabled ? ', disabled' : ''}. Shift+click to ${disabled ? 'enable' : 'disable'} it.` : 'No opacity mask. Click to make one from the selection.');
    this.maskBtn.disabled = !hasMask && !canMakeMask(ed);
    this.note.hidden = hasMask || canMakeMask(ed) || !this.thumbsShown;
    if (this.thumbsShown) this.drawThumbs(ed, sel);
  }

  drawThumbs(ed, sel) {
    // Redraw only when the selected object changed (nodes are immutable).
    const key = sel.length === 1 ? sel[0] : sel.length;
    if (key === this.thumbKey) return;
    this.thumbKey = key;
    const node = sel.length === 1 ? sel[0] : null;
    paintThumb(this.thumb, node ? (ctx, w) => drawThumbnail(ctx, ed.doc, { ...node, opacityMask: undefined }, w) : null);
    const om = node?.opacityMask;
    paintThumb(this.maskThumb, om ? (ctx, w) => {
      // The mask shows on its background: black when it clips, white otherwise.
      ctx.fillStyle = om.clip ? '#000000' : '#ffffff';
      ctx.fillRect(0, 0, w, w);
      const root = maskRootNode(ed.doc, om);
      if (root) drawThumbnail(ctx, maskView(ed.doc, om), root, w);
    } : null);
  }
}

/** A thumbnail on a checkerboard (transparency shows through). */
function paintThumb(canvas, draw) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  ctx.clearRect(0, 0, w, w);
  for (let y = 0; y < w; y += 6) for (let x = 0; x < w; x += 6) {
    ctx.fillStyle = ((x + y) / 6) % 2 ? '#d9d9d9' : '#ffffff';
    ctx.fillRect(x, y, 6, 6);
  }
  draw?.(ctx, w);
}
