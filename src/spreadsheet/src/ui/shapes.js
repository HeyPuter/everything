/**
 * Insert ▸ Shapes and Insert ▸ Icons: drawings placed on the sheet as pictures (SVG, which the file keeps as a
 * vector with a PNG fallback), so they move, resize, copy and print as pictures do.
 */
import { el } from './dom.js';
import { openMenu } from './menu.js';
import { openModal } from './modal.js';
import { COMMAND_ICONS } from './command-icons.js';
import { t } from '../i18n/index.js';

const FILL = '#3a78d0', LINE = '#2a5ea8';
const poly = (pts) => `<polygon points="${pts}" fill="${FILL}" stroke="${LINE}" stroke-width="2"/>`;
/** Each shape on a 100 × 100 canvas (lines on 100 × 20), with the size it takes on the sheet. */
export const SHAPES = [
  ['line', 'Line', 'Lines', 144, 24, `<line x1="2" y1="10" x2="98" y2="10" stroke="${LINE}" stroke-width="3"/>`, '0 0 100 20'],
  ['arrow', 'Arrow', 'Lines', 144, 24, `<line x1="2" y1="10" x2="86" y2="10" stroke="${LINE}" stroke-width="3"/><polygon points="84,3 98,10 84,17" fill="${LINE}"/>`, '0 0 100 20'],
  ['rect', 'Rectangle', 'Rectangles', 144, 96, `<rect x="2" y="2" width="96" height="96" fill="${FILL}" stroke="${LINE}" stroke-width="2"/>`],
  ['roundRect', 'Rounded Rectangle', 'Rectangles', 144, 96, `<rect x="2" y="2" width="96" height="96" rx="16" fill="${FILL}" stroke="${LINE}" stroke-width="2"/>`],
  ['oval', 'Oval', 'Basic Shapes', 120, 96, `<ellipse cx="50" cy="50" rx="48" ry="48" fill="${FILL}" stroke="${LINE}" stroke-width="2"/>`],
  ['triangle', 'Triangle', 'Basic Shapes', 120, 96, poly('50,2 98,98 2,98')],
  ['diamond', 'Diamond', 'Basic Shapes', 120, 96, poly('50,2 98,50 50,98 2,50')],
  ['pentagon', 'Pentagon', 'Basic Shapes', 110, 104, poly('50,2 98,38 80,98 20,98 2,38')],
  ['hexagon', 'Hexagon', 'Basic Shapes', 120, 104, poly('25,2 75,2 98,50 75,98 25,98 2,50')],
  ['rightArrow', 'Right Arrow', 'Block Arrows', 144, 80, poly('2,30 62,30 62,6 98,50 62,94 62,70 2,70')],
  ['leftArrow', 'Left Arrow', 'Block Arrows', 144, 80, poly('98,30 38,30 38,6 2,50 38,94 38,70 98,70')],
  ['upArrow', 'Up Arrow', 'Block Arrows', 80, 144, poly('30,98 30,38 6,38 50,2 94,38 70,38 70,98')],
  ['downArrow', 'Down Arrow', 'Block Arrows', 80, 144, poly('30,2 30,62 6,62 50,98 94,62 70,62 70,2')],
  ['star', 'Star: 5 Points', 'Stars and Banners', 120, 114, poly('50,3 61,37 97,37 68,59 79,94 50,72 21,94 32,59 3,37 39,37')],
  ['callout', 'Speech Bubble: Rectangle', 'Callouts', 160, 104, `<path d="M4 4h92v64H40l-20 26 4-26H4z" fill="${FILL}" stroke="${LINE}" stroke-width="2"/>`],
  ['heart', 'Heart', 'Basic Shapes', 110, 100, `<path d="M50 94C18 70 2 52 2 30 2 14 14 4 28 4c10 0 18 6 22 14C54 10 62 4 72 4c14 0 26 10 26 26 0 22-16 40-48 64z" fill="${FILL}" stroke="${LINE}" stroke-width="2"/>`],
];

/** Each shape's name and each group's heading in the gallery, as catalog keys (SHAPES keeps the English name an inserted shape is called by in the file). */
const SHAPE_LABELS = {
  line: 'shapes.shape.line',
  arrow: 'shapes.shape.arrow',
  rect: 'shapes.shape.rect',
  roundRect: 'shapes.shape.roundRect',
  oval: 'shapes.shape.oval',
  triangle: 'shapes.shape.triangle',
  diamond: 'shapes.shape.diamond',
  pentagon: 'shapes.shape.pentagon',
  hexagon: 'shapes.shape.hexagon',
  rightArrow: 'shapes.shape.rightArrow',
  leftArrow: 'shapes.shape.leftArrow',
  upArrow: 'shapes.shape.upArrow',
  downArrow: 'shapes.shape.downArrow',
  star: 'shapes.shape.star',
  callout: 'shapes.shape.callout',
  heart: 'shapes.shape.heart',
};
const GROUP_LABELS = {
  'Lines': 'shapes.group.lines',
  'Rectangles': 'shapes.group.rectangles',
  'Basic Shapes': 'shapes.group.basicShapes',
  'Block Arrows': 'shapes.group.blockArrows',
  'Stars and Banners': 'shapes.group.starsAndBanners',
  'Callouts': 'shapes.group.callouts',
};

export function shapeSvg(key) {
  const shape = SHAPES.find(([k]) => k === key);
  if (!shape) return null;
  const [, label, , w, h, body, viewBox = '0 0 100 100'] = shape;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}" preserveAspectRatio="none">${body}</svg>`;
  return { svg, w, h, label };
}

/** An icon of the app's set as a standalone picture: its theme colours written into the file it travels in. */
export function iconSvg(name, size = 96) {
  const body = COMMAND_ICONS[name];
  if (!body) return null;
  const css = `*{stroke-width:.9;stroke-linecap:round;stroke-linejoin:round}.thick{stroke-width:1.3}.grip{stroke-width:1.9}.knock{fill:#fff;stroke:none}.wh{fill:none;stroke:#fff}.glint{fill:#fff;stroke:none;opacity:.85}.glassy{fill-opacity:.78}.dash{stroke-dasharray:1.5 1.5}.ln{opacity:.4}
.o{fill:none;stroke:#2c2c2e}.of{fill:#f6f7fa;stroke:#636366}.s,.tx{fill:#2c2c2e;stroke:none}.w{fill:none;stroke:#fff}.txb,.txb2{fill:#007aff}.txw{fill:#fff}
.b{fill:none;stroke:#007aff}.bf{fill:#d3e6ff;stroke:#007aff}.bs{fill:#1a84ff}.bw{fill:#d3e6ff}
.g{fill:none;stroke:#1fa34a}.gf{fill:#cff3d9;stroke:#1fa34a}.gs{fill:#33b85c}.gw{fill:#cff3d9}
.r{fill:none;stroke:#e8352b}.rf{fill:#ffd6d2;stroke:#e8352b}.rs{fill:#f04a40}.rw{fill:#ffd6d2}
.y{fill:none;stroke:#f2b600;stroke-width:2.5}.yf{fill:#ffeeab;stroke:#ea8600}.ys{fill:#f8c51f}
.n{fill:none;stroke:#ea8600}.nf{fill:#ffe3bc;stroke:#ea8600}.ns{fill:#f79a20}.nw{fill:#ffe3bc}
.p{fill:none;stroke:#a845d6}.pf{fill:#eed6fa;stroke:#a845d6}.ps{fill:#b45fdf}.pw{fill:#eed6fa}`;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="${size}" height="${size}"><style>${css}</style>${body}</svg>`, w: size, h: size };
}

export const svgDataUrl = (svg) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

/** The Shapes gallery, grouped by kind. */
export function openShapesMenu(anchor, run) {
  const groups = [...new Set(SHAPES.map(([, , group]) => group))];
  const section = (group) => el('div.shape-group', {},
    el('div.menu-header', {}, t(GROUP_LABELS[group])),
    el('div.shape-grid', { role: 'group', 'aria-label': t(GROUP_LABELS[group]) }, ...SHAPES.filter(([, , g]) => g === group).map(([key, , , , , body, viewBox = '0 0 100 100']) => {
      const label = t(SHAPE_LABELS[key]);
      return el('button.shape-cell', { type: 'button', role: 'menuitem', title: label, 'aria-label': label, onclick: () => { menu.close(); run('insertShape', key); },
        html: `<svg viewBox="${viewBox}" width="26" height="22" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${body}</svg>` });
    })));
  const menu = openMenu({ anchor, label: t('shapes.menuLabel'), minWidth: 260, items: groups.map((group) => ({ custom: section(group) })) });
  menu?.el?.querySelector?.('.shape-cell')?.focus?.();
  return menu;
}

/** Insert ▸ Icons: the app's icon set, searchable by name; Insert places the chosen ones on the sheet. */
export function openIconsDialog(ctx) {
  const names = Object.keys(COMMAND_ICONS).filter((n) => !/^border(?!s$)|^(decLess|decMore|errorCheck2|pageBreak2)$/.test(n));
  const chosen = new Set();
  const search = el('input.input', { type: 'search', placeholder: t('shapes.searchIcons'), 'aria-label': t('shapes.searchIcons'), autocomplete: 'off' });
  const grid = el('div.icon-pick-grid', { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': t('shapes.icons') });
  const label = (n) => n.replace(/([A-Z])/g, ' $1').toLowerCase();
  const show = () => {
    const q = search.value.trim().toLowerCase();
    grid.replaceChildren(...names.filter((n) => !q || label(n).includes(q)).map((n) => el('button.icon-pick', {
      type: 'button', role: 'option', 'aria-selected': String(chosen.has(n)), title: label(n), 'aria-label': label(n),
      onclick: (e) => { if (chosen.has(n)) chosen.delete(n); else chosen.add(n); e.currentTarget.setAttribute('aria-selected', String(chosen.has(n))); insertBtn.disabled = !chosen.size; },
      html: `<img alt="" src="${svgDataUrl(iconSvg(n, 40).svg)}" width="40" height="40">`,
    })));
  };
  const insertBtn = el('button.btn.btn-primary', { type: 'submit', disabled: true }, t('common.insert'));
  search.addEventListener('input', show);
  const content = el('form.icons-dialog', { onsubmit: (e) => { e.preventDefault(); if (!chosen.size) return; modal.close(); ctx.run('insertIcons', [...chosen]); } },
    search, grid,
    el('div.row.row-end', { style: { marginTop: '12px' } }, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), insertBtn));
  show();
  const modal = openModal({ title: t('shapes.insertIcons'), content, wide: true, initialFocus: search, onClose: () => ctx.grid.focus() });
  return modal;
}
