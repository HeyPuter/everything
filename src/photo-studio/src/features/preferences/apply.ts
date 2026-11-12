// Applies preferences that change the workspace's look (CSS variables and
// classes) and settings other features read at the time they are used.
import type { Editor } from '../../editor';
import { canvasColorValue, CHECKER_SIZES, checkerColors, HIGHLIGHTS } from '../../model/preferences';
import { fileNaming } from '../../persistence/puter';

const FONT_ZOOM = { small: 0.92, medium: 1, large: 1.12 } as const;

export function applyPreferences(e: Editor) {
  const p = e.preferences,
    app = e.root,
    html = document.documentElement;
  if (html.dataset.theme !== p.theme) e.setTheme(p.theme);
  // Highlight color: the blue default keeps each theme's own accent.
  const h = HIGHLIGHTS[p.highlightColor];
  for (const [k, v] of [['--accent', h.accent], ['--row-selected', h.row], ['--row-selected-light', h.rowLight]] as const) {
    if (p.highlightColor === 'blue') html.style.removeProperty(k);
    else html.style.setProperty(k, v);
  }
  html.classList.toggle('highlight-custom', p.highlightColor !== 'blue');
  // UI font size and scaling zoom the chrome around the canvas.
  const scale = p.uiScale / 100,
    text = FONT_ZOOM[p.uiFontSize];
  app.classList.toggle('ui-scaled', scale !== 1 || text !== 1);
  app.style.setProperty('--ui-zoom', String(scale));
  app.style.setProperty('--ui-text-zoom', String(Math.round(scale * text * 1000) / 1000));
  // Canvas color per screen mode and the image border.
  ([['--canvas-mode-0', p.canvasColorStandard], ['--canvas-mode-1', p.canvasColorFullMenus], ['--canvas-mode-2', p.canvasColorFull]] as const).forEach(([k, v]) => {
    const c = canvasColorValue(v);
    if (c) app.style.setProperty(k, c);
    else app.style.removeProperty(k);
  });
  app.dataset.canvasBorder = p.canvasBorder;
  app.classList.toggle('panel-animations', p.panelAnimations);
  document.body.classList.toggle('panel-animations-root', p.panelAnimations);
  app.classList.toggle('large-tabs', p.largeTabs);
  app.classList.toggle('narrow-options', p.narrowOptionsBar);
  // Transparency checkerboard.
  const [a, b] = checkerColors(p);
  html.style.setProperty('--checker-a', a);
  html.style.setProperty('--checker-b', b);
  // Guides, grid and slices.
  app.style.setProperty('--guide-color', p.guideColor);
  app.style.setProperty('--smart-guide-color', p.smartGuideColor);
  app.style.setProperty('--grid-color', p.gridColor);
  app.style.setProperty('--slice-color', p.sliceColor);
  app.dataset.guideStyle = p.guideStyle;
  app.dataset.gridStyle = p.gridStyle;
  app.classList.toggle('hide-slice-numbers', !p.sliceNumbers);
  // History length applies to open documents too.
  for (const s of e.sessions) {
    const kept = s.history.labels.length + s.history.redoLabels.length;
    s.history.limit = p.historyStates;
    s.history.trim();
    // Free the pixels of the steps just dropped now, not after later edits.
    if (s.history.labels.length + s.history.redoLabels.length < kept) s.collectTiles();
  }
  fileNaming.extensionCase = p.extensionCase;
  syncCheckerSize(e);
}

/** The checkerboard keeps a fixed size on screen at any zoom. */
export function syncCheckerSize(e: Editor) {
  const size = CHECKER_SIZES[e.preferences.checkerSize] || 8;
  const zoom = Math.max(1e-3, e.zoom);
  e.root.style.setProperty('--checker-period', `${(2 * size) / zoom}px`);
  e.root.style.setProperty('--inv-zoom', String(1 / zoom));
}
