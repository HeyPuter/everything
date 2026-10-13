/**
 * Paint and appearance feature: Color, Swatches, Gradient, Stroke,
 * Transparency, Appearance and Graphic Styles panels, the Gradient tool,
 * the Color Picker dialog, the Effect menu, Edit > Edit Colors, and the
 * renderer hooks for arrowheads and corner-aligned dashes.
 *
 * Hooks for other modules:
 *   app.openColorPicker(which)       Color Picker for 'fill' | 'stroke'
 *   app.arrowheadPaths(node)         [{ anchors, closed }] arrowheads in document space
 *   app.strokeAnchors(node)          the stroked path's anchors after arrowhead trimming
 *   app.dashPattern(node)            { dash, offset } actually used to stroke the node
 */
import './styles.css';
import { drawHooks, tracePath } from '../../render/draw.js';
import { pathLength } from '../../model/bezier.js';
import { applyStyle, commonStyle } from '../../ops/paint-ops.js';
import { registerPaintIcons } from './icons.js';
import { ColorPanel } from './color-panel.js';
import { SwatchesPanel } from './swatches-panel.js';
import { GradientPanel } from './gradient-panel.js';
import { StrokePanel } from './stroke-panel.js';
import { TransparencyPanel, registerTransparencyCommands } from './transparency-panel.js';
import { installOpacityMasks } from './opacity-mask.js';
import { installFreeform } from './freeform.js';
import { AppearancePanel, GraphicStylesPanel, graphicStyleLibraryMenu } from './appearance-panel.js';
import { GradientTool } from './gradient-tool.js';
import { registerEffectCommands } from './effects-ui.js';
import { registerEditColorCommands } from './edit-colors-ui.js';
import { nodeArrowheads, arrowTrim, trimAnchors, alignedDash } from './stroke-geometry.js';
import { setFocusedColor, displayColor } from './ui-common.js';
import { isGradient } from '../../model/gradients.js';
import { installRecentColors } from './recent-colors.js';
import { swatchLibraryMenu } from './swatch-libraries.js';

const arrowCache = new WeakMap();
const trimCache = new WeakMap();
const dashCache = new WeakMap();

function arrowPaths(node) {
  let hit = arrowCache.get(node);
  if (!hit) {
    const contours = nodeArrowheads(node);
    hit = contours.length ? [contours.reduce((p, c) => tracePath(p, c.anchors, c.closed), new Path2D())] : null;
    arrowCache.set(node, hit);
  }
  return hit;
}

export function strokeAnchors(node) {
  if (node.type !== 'path' || node.closed) return node.anchors;
  const t = arrowTrim(node);
  if (!t.start && !t.end) return node.anchors;
  return trimAnchors(node.anchors, t.start, t.end);
}

function strokePath(node) {
  if (node.type !== 'path' || node.closed || (!node.arrowStart && !node.arrowEnd)) return null;
  let hit = trimCache.get(node);
  if (hit === undefined) {
    const t = arrowTrim(node);
    hit = t.start || t.end ? tracePath(new Path2D(), trimAnchors(node.anchors, t.start, t.end), false) : null;
    trimCache.set(node, hit);
  }
  return hit;
}

export function dashPattern(node) {
  if (node.dashAlign !== 'corners' || !node.dash || !node.dash.length || node.type !== 'path') return null;
  let hit = dashCache.get(node);
  if (hit === undefined) {
    hit = alignedDash(node.dash, pathLength(strokeAnchors(node), node.closed), node.closed);
    dashCache.set(node, hit);
  }
  return hit;
}

export function install(app) {
  registerPaintIcons();
  drawHooks.arrowheads = arrowPaths;
  drawHooks.strokePath = (node) => strokePath(node);
  drawHooks.dashPattern = (node) => dashPattern(node);
  app.arrowheadPaths = (node) => nodeArrowheads(node);
  app.strokeAnchors = (node) => strokeAnchors(node);
  app.dashPattern = (node) => dashPattern(node) || (node.dash?.length ? { dash: node.dash, offset: node.dashOffset || 0 } : null);

  for (const P of [ColorPanel, SwatchesPanel, StrokePanel, GradientPanel, TransparencyPanel, AppearancePanel, GraphicStylesPanel]) app.registerPanel(P);
  app.registerTool(GradientTool);
  registerEffectCommands(app);
  registerEditColorCommands(app);
  installRecentColors(app);
  installOpacityMasks();
  installFreeform();
  registerTransparencyCommands(app);

  // New Art Has Basic Appearance (on by default): new paths leave out the current effects.
  const syncBasic = () => {
    for (const ed of app.editors?.values?.() || [app.editor]) if (ed) ed.basicNewArt = app.prefs.get('newArtBasic') !== false;
  };
  app.on('active-editor', syncBasic);
  app.prefs.on('change', ({ key }) => key === 'newArtBasic' && syncBasic());

  // Window > Graphic Style Libraries: open a library in the Graphic Styles panel.
  app.menuSources.set('graphicStyleLibraries', (a) =>
    graphicStyleLibraryMenu(a, (lib) => {
      a.openPanel('graphicStyles');
      a.dock.panels.get('graphicStyles')?.openLibrary(lib);
    }),
  );

  // Window > Swatch Libraries: open a library in the Swatches panel.
  app.menuSources.set('swatchLibraries', (a) =>
    swatchLibraryMenu(a, (lib) => {
      a.openPanel('swatches');
      a.dock.panels.get('swatches')?.openLibraryFromMenu(lib);
    }),
  );

  app.openColorPicker = async (which = 'fill') => {
    const ed = app.editor;
    if (!ed) return;
    ed.focusPaint = which;
    ed.emit('style');
    const cur = commonStyle(ed, which);
    const value = displayColor(ed, which, cur);
    const { openColorPickerDialog } = await import('./color-dialog.js');
    const hex = await openColorPickerDialog(app, { value, title: 'Color Picker', swatches: ed.doc.root.swatches || [] });
    if (!hex || app.editor !== ed) return;
    if (cur && cur !== 'mixed' && isGradient(cur)) setFocusedColor(ed, hex);
    else {
      ed.lastSolid = { ...(ed.lastSolid || {}), [which]: hex };
      applyStyle(ed, { [which]: { type: 'solid', color: hex } }, which === 'fill' ? 'Fill Color' : 'Stroke Color');
    }
  };
}
