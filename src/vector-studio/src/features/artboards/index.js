/**
 * Artboards, navigation panels and the remaining transform/selection tools:
 *
 *  - Artboard tool (Shift+O) with its Properties controls and dialogs,
 *    Artboards panel, Object > Artboards commands
 *  - Align (Shift+F7), Transform (Shift+F8), Info (F8) and Navigator panels
 *  - Free Transform (E), Magic Wand (Y), Measure, Reshape and Blend (W)
 *    tools, Object > Blend commands with live blends and the Blend panel
 *  - the task bar, guide selection with the Selection tool,
 *    key objects and Object > Transform > Reset Bounding Box
 */
import './styles.css';
import { SquarePlus, RectangleHorizontal, RectangleVertical, Compass, Shapes, PenLine, SquareMousePointer } from 'lucide';
import { registerIcons } from '../../ui/icons.js';
import { PropertiesPanel } from '../../ui/panels/properties.js';
import { nodeFrameAngle } from '../../model/geometry.js';
import { ArtboardTool } from './artboard-tool.js';
import { artboardControlsSection } from './controls.js';
const dialogs = () => import('./dialogs.js'); // loaded on first use
import { ArtboardsPanel, pickedArtboards, duplicateArtboards, deleteArtboards, emptyArtboards } from './artboards-panel.js';
import { moveArtworkEnabled } from './artboard-tool.js';
import { AlignPanel } from './align-panel.js';
import { TransformPanel } from './transform-panel.js';
import { InfoPanel } from './info-panel.js';
import { NavigatorPanel } from './navigator-panel.js';
import { FreeTransformTool } from './free-transform.js';
import { MagicWandTool } from './magic-wand.js';
import { MeasureTool, ReshapeTool } from './measure-reshape.js';
import { BlendTool, registerBlendCommands } from './blend.js';
import { BlendPanel } from './blend-panel.js';
import { installTaskbar } from './taskbar.js';
import { installSelectionExtensions, setGuide } from './selection-ext.js';
import { convertToArtboards, isRectangle, fitArtboardToArtwork, fitArtboardToIds } from './artboard-ops.js';

const R = (d, extra = {}) => ['rect', { ...d, ...extra }];
const P = (d, extra = {}) => ['path', { d, ...extra }];

registerIcons({
  'artboard-new': SquarePlus,
  'orient-portrait': RectangleVertical,
  'orient-landscape': RectangleHorizontal,
  compass: Compass,
  shapes: Shapes,
  'pen-line': PenLine,
  'square-mouse-pointer': SquareMousePointer,
  'artboard-options': [R({ x: '3', y: '4', width: '18', height: '16', rx: '1' }), P('M7 9h4M7 15h10'), ['circle', { cx: '14', cy: '9', r: '1.5' }]],
  'layout-grid-row': [R({ x: '3', y: '3', width: '7', height: '7' }), R({ x: '14', y: '3', width: '7', height: '7' }), R({ x: '3', y: '14', width: '7', height: '7' }), P('M10 6.5h4M10 6.5l-6 11', { 'stroke-dasharray': '2 2' })],
  'layout-grid-col': [R({ x: '3', y: '3', width: '7', height: '7' }), R({ x: '3', y: '14', width: '7', height: '7' }), R({ x: '14', y: '3', width: '7', height: '7' }), P('M6.5 10v4M6.5 10l11-6', { 'stroke-dasharray': '2 2' })],
  'layout-row': [R({ x: '2', y: '8', width: '5', height: '8' }), R({ x: '9.5', y: '8', width: '5', height: '8' }), R({ x: '17', y: '8', width: '5', height: '8' })],
  'layout-col': [R({ x: '8', y: '2', width: '8', height: '5' }), R({ x: '8', y: '9.5', width: '8', height: '5' }), R({ x: '8', y: '17', width: '8', height: '5' })],
  'ft-constrain': [R({ x: '4', y: '9', width: '7', height: '11' }), P('M14 4h6v6'), P('m20 4-6 6'), P('M11 9 14 6', { 'stroke-dasharray': '1.5 1.5' })],
  'ft-free': [R({ x: '5', y: '5', width: '14', height: '14' }), R({ x: '3', y: '3', width: '4', height: '4', fill: 'currentColor' }), R({ x: '17', y: '17', width: '4', height: '4', fill: 'currentColor' })],
  'ft-perspective': [P('M7 5h10l3 14H4z', { 'stroke-linejoin': 'round' }), ['circle', { cx: '20', cy: '19', r: '2', fill: 'currentColor' }]],
  'ft-distort': [P('M4 6 18 3l2 15-15 3z', { 'stroke-linejoin': 'round' }), ['circle', { cx: '18', cy: '3.5', r: '2', fill: 'currentColor' }]],
  'shear-angle': [P('M8 5h12l-4 14H4z', { 'stroke-linejoin': 'round' })],
  'corner-radius': [P('M4 20V11a7 7 0 0 1 7-7h9')],
});

const hasDoc = (a) => Boolean(a.editor);

function registerArtboardCommands(app) {
  const ed = () => app.editor;
  app.commands.register([
    {
      id: 'artboards.options',
      label: 'Artboard Options...',
      enabled: hasDoc,
      run: async (a, args) => (await dialogs()).artboardOptionsDialog(a, args?.index ?? a.editor.activeArtboard),
    },
    {
      id: 'artboards.convert',
      label: 'Convert to Artboards',
      enabled: (a) => Boolean(a.editor?.selectedNodes().some(isRectangle)),
      run: () => {
        const e = ed();
        let made = [];
        e.doc.transact('Convert to Artboards', () => {
          made = convertToArtboards(e.doc, e.topSelection());
        });
        if (made.length) e.setActiveArtboard(made[made.length - 1]);
      },
    },
    { id: 'artboards.rearrange', label: 'Rearrange All Artboards...', enabled: hasDoc, run: async (a) => (await dialogs()).rearrangeDialog(a) },
    {
      id: 'artboards.fitArtwork',
      label: 'Fit to Artwork Bounds',
      enabled: hasDoc,
      run: () => {
        const e = ed();
        let ok = false;
        e.doc.transact('Fit to Artwork Bounds', () => {
          ok = fitArtboardToArtwork(e.doc, e.activeArtboard);
        });
        if (!ok) app.notify('There is no artwork on the active artboard.');
      },
    },
    {
      id: 'artboards.fitSelection',
      label: 'Fit to Selected Art',
      enabled: (a) => Boolean(a.editor?.selection.size),
      run: () => {
        const e = ed();
        e.doc.transact('Fit to Selected Art', () => fitArtboardToIds(e.doc, e.activeArtboard, e.topSelection()));
      },
    },
    {
      id: 'artboards.new',
      label: 'New Artboard',
      enabled: hasDoc,
      run: (a) => a.dock.panels.get('artboards').newArtboard(),
    },
    {
      id: 'artboards.duplicate',
      label: (a) => (pickedArtboards(a).length > 1 ? 'Duplicate Artboards' : 'Duplicate Artboard'),
      enabled: hasDoc,
      run: (a) => {
        const e = ed();
        let made = [];
        e.doc.transact('Duplicate Artboards', () => {
          made = duplicateArtboards(e.doc, pickedArtboards(a), { withArtwork: moveArtworkEnabled(a) });
        });
        if (made.length) e.setActiveArtboard(made.at(-1));
      },
    },
    {
      id: 'artboards.delete',
      label: (a) => (pickedArtboards(a).length > 1 ? 'Delete Artboards' : 'Delete Artboard'),
      enabled: (a) => Boolean(a.editor && a.editor.doc.artboards.length > 1),
      run: (a) => {
        const e = ed();
        const picked = pickedArtboards(a);
        let n = 0;
        e.doc.transact(picked.length > 1 ? 'Delete Artboards' : 'Delete Artboard', () => {
          n = deleteArtboards(e.doc, picked);
        });
        if (n < picked.length) a.notify('A document needs at least one artboard.');
        e.setActiveArtboard(Math.min(picked[0], e.doc.artboards.length - 1));
      },
    },
    {
      id: 'artboards.deleteEmpty',
      label: 'Delete Empty Artboards',
      enabled: (a) => Boolean(a.editor && a.editor.doc.artboards.length > 1),
      run: (a) => {
        const e = ed();
        const empty = emptyArtboards(e.doc);
        if (!empty.length) return a.notify('Every artboard has artwork on it.', { polite: true });
        let n = 0;
        e.doc.transact('Delete Empty Artboards', () => {
          n = deleteArtboards(e.doc, empty);
        });
        e.setActiveArtboard(Math.min(e.activeArtboard, e.doc.artboards.length - 1));
        a.notify(`Deleted ${n} empty artboard${n === 1 ? '' : 's'}.`, { polite: true });
      },
    },
    {
      id: 'artboards.moveUp',
      label: 'Move Up',
      enabled: (a) => Boolean(a.editor && a.editor.activeArtboard > 0),
      run: (a) => a.dock.panels.get('artboards').move(-1),
    },
    {
      id: 'artboards.moveDown',
      label: 'Move Down',
      enabled: (a) => Boolean(a.editor && a.editor.activeArtboard < a.editor.doc.artboards.length - 1),
      run: (a) => a.dock.panels.get('artboards').move(1),
    },
    {
      id: 'artboards.resetNames',
      label: 'Reset Names',
      enabled: (a) => Boolean(a.editor?.doc.artboards.some((b, i) => b.name !== `Artboard ${i + 1}`)),
      run: () => {
        const e = ed();
        e.doc.transact('Reset Artboard Names', () => e.doc.updateRoot({ artboards: e.doc.artboards.map((b, i) => ({ ...b, name: `Artboard ${i + 1}` })) }));
      },
    },
    {
      id: 'object.resetBoundingBox',
      label: 'Reset Bounding Box',
      enabled: (a) => Boolean(a.editor?.selectedNodes().some((n) => Math.abs(nodeFrameAngle(n)) > 1e-6)),
      run: () => {
        const e = ed();
        e.doc.transact('Reset Bounding Box', () => {
          for (const n of e.selectedNodes()) if (Math.abs(nodeFrameAngle(n)) > 1e-6) e.doc.update(n.id, { frameAngle: 0 });
        });
      },
    },
  ]);

  // Delete removes the active artboard with the Artboard tool, or the selected guide.
  const clear = app.commands.get('edit.clear');
  const guideSelected = (a) => a.editor?.selectedGuide != null && !a.editor.selection.size;
  app.commands.register({
    ...clear,
    enabled: (a, args) => (a.toolId === 'artboard' && Boolean(a.editor)) || guideSelected(a) || clear.enabled(a, args),
    run: (a, args) => {
      if (a.toolId === 'artboard') return a.getTool('artboard').deleteActive();
      if (guideSelected(a)) {
        const e = a.editor;
        const i = e.selectedGuide;
        e.selectedGuide = null;
        e.doc.transact('Delete Guide', () => setGuide(e.doc, i, null));
        return true;
      }
      return clear.run(a, args);
    },
  });
}

export function install(app) {
  for (const T of [ArtboardTool, FreeTransformTool, MagicWandTool, MeasureTool, ReshapeTool, BlendTool]) app.registerTool(T);
  for (const P of [AlignPanel, ArtboardsPanel, BlendPanel, InfoPanel, NavigatorPanel, TransformPanel]) app.registerPanel(P);
  PropertiesPanel.extraSections.push(artboardControlsSection(app));
  registerArtboardCommands(app);
  registerBlendCommands(app);
  installSelectionExtensions(app);
  app.on('tool', () => app.dock?.update());
  app.on('started', () => installTaskbar(app));
}
