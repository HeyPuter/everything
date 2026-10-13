/**
 * Brushes and variable-width strokes: calligraphic, scatter, art, pattern
 * and bristle brushes (stored in the document, applied per path as live
 * artwork), the Brushes panel and brush libraries, the Paintbrush with
 * brushes, the Width tool and width profiles in the Stroke and Properties
 * panels, Select > Object > Brush Strokes, and Outline Stroke / Expand for
 * brushed and variable-width paths.
 */
import './styles.css';
import './live-kinds.js';
import { registerBrushIcons } from './icons.js';
import { BrushesPanel, libraryMenuItems } from './brushes-panel.js';
import { WidthTool } from './width-tool.js';
import { BrushPaintbrushTool } from './paintbrush-tool.js';
import { strokeProfileSection, propertiesBrushSection } from './profiles-ui.js';
import { selectBrushStrokes, brushTargets, brushClipboardHook } from './brush-ops.js';
import { clipboardHooks } from '../../ops/clipboard.js';
import { brushState, newBrush, editSelectedStrokeOptions } from './brush-actions.js';
import { StrokePanel } from '../paint/stroke-panel.js';
import { PropertiesPanel } from '../../ui/panels/properties.js';
import { isLive, expandLive } from '../../model/live.js';

export function install(app) {
  registerBrushIcons();
  brushState(app);
  app.registerPanel(BrushesPanel);
  app.registerTool(WidthTool);
  app.registerTool(BrushPaintbrushTool);
  app.menuSources.set('brushLibraries', (a) => libraryMenuItems(a));
  // Sections are shared by every app instance; their build(app) gets the app.
  if (!StrokePanel.extraSections.some((s) => s.id === 'width-profile')) StrokePanel.extraSections.push({ id: 'width-profile', build: (a) => strokeProfileSection(a) });
  if (!PropertiesPanel.extraSections.some((s) => s.id === 'brush-stroke')) PropertiesPanel.extraSections.push(propertiesBrushSection());

  if (!clipboardHooks.includes(brushClipboardHook)) clipboardHooks.push(brushClipboardHook);

  const hasDoc = (a) => Boolean(a.editor);
  app.commands.register([
    { id: 'select.object.brushStrokes', label: 'Brush Strokes', enabled: hasDoc, run: (a) => selectBrushStrokes(a.editor) },
    { id: 'select.object.bristleStrokes', label: 'Bristle Brush Strokes', enabled: hasDoc, run: (a) => selectBrushStrokes(a.editor, 'bristle') },
    { id: 'brush.new', label: 'New Brush...', enabled: hasDoc, run: (a) => newBrush(a) },
    {
      id: 'brush.strokeOptions',
      label: 'Options of Selected Object...',
      enabled: (a) => Boolean(a.editor && brushTargets(a.editor).some((n) => n.brush)),
      run: (a) => editSelectedStrokeOptions(a),
    },
  ]);

  // Delete removes the Width tool's selected width points instead of the path.
  const clear = app.commands.get('edit.clear');
  if (clear) {
    const widthPoints = (a) => a.toolId === 'width' && a.getTool('width')?.hasSelectedPoints();
    app.commands.register({
      ...clear,
      enabled: (a, args) => widthPoints(a) || clear.enabled(a, args),
      run: (a, args) => (widthPoints(a) ? a.getTool('width').deleteSelected() : clear.run(a, args)),
    });
  }

  // Outline Stroke on brush strokes and variable widths gives their artwork.
  const outline = app.commands.get('path.outlineStroke');
  if (outline) {
    const liveStrokes = (a) => (a.editor ? brushTargets(a.editor).filter((n) => isLive(n)) : []);
    app.commands.register({
      ...outline,
      enabled: (a, args) => liveStrokes(a).length > 0 || outline.enabled(a, args),
      run: async (a, args) => {
        const live = liveStrokes(a);
        if (!live.length) return outline.run(a, args);
        const ed = a.editor;
        const doc = ed.doc;
        const done = new Set(live.map((n) => n.id));
        const rest = ed.topSelection().filter((id) => !done.has(id));
        const out = [];
        doc.transact('Outline Stroke', () => live.forEach((n) => out.push(expandLive(doc, n.id)?.id)));
        if (rest.length) {
          ed.select(rest);
          if (outline.enabled(a, args)) await outline.run(a, args);
          out.push(...ed.selection);
        }
        ed.select(out.filter((id) => id && doc.has(id)));
        return true;
      },
    });
  }
}
