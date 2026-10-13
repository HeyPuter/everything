/**
 * Type feature: fonts, type tools, on-canvas editing, rich text styling,
 * the Character and Paragraph panels, the Type menu, Find and Replace and
 * outline conversion.
 */
import './styles.css';
import { installFonts } from './fonts.js';
import { TypeTool, AreaTypeTool, TypeOnPathTool, VerticalTypeTool } from './tools.js';
import { overlayHooks } from '../../render/overlay.js';
import { typeOverlay } from './overlay.js';
import { paintHooks, paintTargets } from '../../ops/paint-ops.js';
import { rangeStyle } from '../../model/text-runs.js';
import { session, applyCharStyle, currentCharStyle, MIXED } from './type-ops.js';
import { textToPathData } from './outlines.js';
import { registerTypeCommands } from './commands.js';
import { installTypePanels } from './panels.js';
import { registerTypeIcons } from './icons.js';
import { installOpenTypeFeatures } from './opentype-install.js';
import { installTypeStyles } from './styles-install.js';
import { installTextServices } from './text-tools-install.js';
import { installThreads } from './threads.js';
import { installTextWrap } from './wrap.js';
import { installLayoutCommands } from './layout-commands.js';
import { CharEditTool } from './char-edit-tool.js';
import { installTabsPanel } from './tabs-panel.js';
import { installTypeOptions } from './type-options.js';

const PAINT = ['fill', 'stroke', 'strokeWidth'];

export function install(app) {
  registerTypeIcons();
  installFonts(app);
  for (const T of [TypeTool, AreaTypeTool, TypeOnPathTool, VerticalTypeTool, CharEditTool]) app.registerTool(T);
  overlayHooks.add(typeOverlay());

  // Fill and stroke changes while editing color the selected characters.
  const prevApply = paintHooks.applyStyle;
  const fallThrough = (editor, patch, label, coalesce) => (prevApply ? prevApply(editor, patch, label, coalesce) : false);
  paintHooks.applyStyle = (editor, patch, label, coalesce) => {
    if (editor !== app.editor || !session(app)) return fallThrough(editor, patch, label, coalesce);
    const run = {};
    for (const k of PAINT) if (k in patch) run[k] = patch[k];
    if (!Object.keys(run).length) return fallThrough(editor, patch, label, coalesce);
    editor.setStyle(patch);
    applyCharStyle(app, run, { label, coalesce });
    return true;
  };
  paintHooks.commonStyle = (editor, key) => {
    if (!PAINT.includes(key)) return undefined;
    if (editor === app.editor && session(app)) {
      const st = currentCharStyle(app);
      if (!st) return undefined;
      return st[key] === MIXED ? 'mixed' : st[key];
    }
    // Selected type objects report the paint their characters actually use.
    const targets = paintTargets(editor);
    if (!targets.some((n) => n.type === 'text' && n.runs)) return undefined;
    const values = targets.map((n) => (n.type === 'text' ? rangeStyle(n, 0, Math.max(1, n.text.length))[key] : n[key]) ?? null);
    const first = JSON.stringify(values[0]);
    return values.some((v) => v === MIXED || JSON.stringify(v) !== first) ? 'mixed' : values[0];
  };

  // Glyph outlines for SVG/PDF export.
  app.textOutlines = textToPathData;

  registerTypeCommands(app);
  installTypeOptions(app);
  installTypePanels(app);
  installOpenTypeFeatures(app);
  installTypeStyles(app);
  installTextServices(app);
  installThreads(app);
  installTextWrap(app);
  installLayoutCommands(app);
  installTabsPanel(app);
}
