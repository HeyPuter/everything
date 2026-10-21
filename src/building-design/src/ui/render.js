/**
 * Render: a presentation image of a 3D view (realistic materials, sun and
 * shadows, a sky), supersampled for smooth edges, at a chosen size.
 */
import { h } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast } from './dialog.js';
import { renderViewImage } from '../views/snapshot.js';
import { download } from '../io/storage.js';
import { safeFileName } from '../io/native.js';

const SIZES = [
  { value: 'view', label: 'Same as the view' },
  { value: '1280x720', label: '1280 x 720' },
  { value: '1920x1080', label: '1920 x 1080 (Full HD)' },
  { value: '2560x1440', label: '2560 x 1440' },
  { value: '3840x2160', label: '3840 x 2160 (4K)' },
  { value: '2000x2000', label: '2000 x 2000 (square)' },
];

const QUALITY = [
  { value: 1, label: 'Draft' },
  { value: 2, label: 'Medium' },
  { value: 3, label: 'High' },
];

const BACKGROUNDS = [
  { value: 'sky', label: 'Sky' },
  { value: 'white', label: 'White' },
  { value: 'transparent', label: 'Transparent' },
];

function select(label, options, value) {
  const s = h('select.input', { 'aria-label': label }, options.map((o) => h('option', { value: String(o.value) }, o.label)));
  s.value = String(value);
  return { s, field: h('label.field', h('span.field-label', label), s) };
}

/** Largest supersampling that stays inside the GPU's limits. */
function maxScale(app, w, h, want) {
  const gl = app.viewport.gl;
  const lim = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
  let k = want;
  while (k > 1 && (w * k > lim || h * k > lim)) k--;
  return k;
}

export function renderDialog(app) {
  const view = app.activeView;
  if (view?.kind !== 'view3d') return toast('Open a 3D view to render it.', { kind: 'error' });
  const size = select('Image size', SIZES, '1920x1080');
  const quality = select('Quality', QUALITY, 2);
  const bg = select('Background', BACKGROUNDS, 'sky');
  const sun = h('input', { type: 'checkbox', checked: true });
  const edges = h('input', { type: 'checkbox', checked: false });
  const preview = h('div.render-preview', h('p.field-hint', 'The rendered image appears here.'));
  let last = null;
  const run = () => {
    const vp = app.viewport;
    let [w, hgt] = size.s.value === 'view' ? [vp.width * vp.dpr, vp.height * vp.dpr] : size.s.value.split('x').map(Number);
    w = Math.round(w);
    hgt = Math.round(hgt);
    const k = maxScale(app, w, hgt, +quality.s.value);
    const cam = app.vc?.cam;
    let img;
    try {
      img = renderViewImage(app, view, w * k, hgt * k, {
        fit: false,
        camera: cam,
        transparent: bg.s.value !== 'white',
        viewPatch: { style: 'realistic', shadows: sun.checked, renderEdges: edges.checked },
      }).canvas;
    } catch (err) {
      console.error(err);
      return toast('The image could not be rendered. Try a smaller size or lower quality.', { kind: 'error' });
    }
    // Downsample for smooth edges, over the chosen background.
    const out = document.createElement('canvas');
    out.width = w;
    out.height = hgt;
    const ctx = out.getContext('2d');
    if (bg.s.value === 'sky') {
      const g = ctx.createLinearGradient(0, 0, 0, hgt);
      g.addColorStop(0, '#7fa8d6');
      g.addColorStop(0.55, '#cfe0f0');
      g.addColorStop(1, '#eef2f4');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, hgt);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, hgt);
    last = out;
    const shown = new Image();
    shown.alt = `Rendering of ${view.name}`;
    shown.src = out.toDataURL('image/png');
    preview.replaceChildren(shown, h('p.field-hint', `${w} x ${hgt} pixels${k > 1 ? `, ${k}x supersampled` : ''}`));
  };
  const save = () => {
    if (!last) run();
    last?.toBlob((blob) => blob && download(blob, `${safeFileName(`${app.doc.project.name || 'Project'} - ${view.name}`)}.png`), 'image/png');
  };
  return openDialog({
    title: `Render ${view.name}`,
    size: 'lg',
    body: h(
      'div.render-layout',
      h('div.render-opts', size.field, quality.field, bg.field, h('label.check', sun, h('span', 'Sun and shadows', h('small.field-hint', ' (from Sun Settings)'))), h('label.check', edges, h('span', 'Outline edges')), h('button.btn', { type: 'button', onClick: () => app.run('sunSettings') }, icon('sun-l', 16), 'Sun Settings...')),
      preview,
    ),
    actions: [
      { label: 'Close', value: null },
      { label: 'Save Image', onClick: () => (save(), false) },
      { label: 'Render', primary: true, onClick: () => (run(), false) },
    ],
  });
}
