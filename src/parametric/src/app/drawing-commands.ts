// Drawing commands for assemblies, sheet metal and weldments: balloons, the bill of materials
// and cut list tables, and the flat pattern view.

import { addIcons } from '../ui/icons';
import type { App } from './app';
import type { Command } from './commands';

addIcons({
  balloon: [['circle', { cx: 9, cy: 9, r: 6, class: 'a' }], ['path', { d: 'M8 7l1.5-1v6' }], ['path', { d: 'M13.3 13.3L19.5 19.5' }], ['circle', { cx: 19.5, cy: 19.5, r: 1.2, class: 'f' }]],
  autoBalloon: [['circle', { cx: 6, cy: 6, r: 3.5, class: 'a' }], ['circle', { cx: 18, cy: 6, r: 3.5, class: 'a' }], ['circle', { cx: 6, cy: 18, r: 3.5, class: 'a' }], ['path', { d: 'M8.5 8.5L12 12M15.5 8.5L12 12M8.5 15.5L12 12' }], ['rect', { x: 13, y: 13, width: 8, height: 8, rx: 0.5 }]],
  drawingBom: [['path', { d: 'M3 5h18v14H3z', class: 's' }], ['path', { d: 'M3 9.5h18M3 14h18M7.5 5v14M17 5v14' }]],
  drawingFlat: 'flatPattern',
});

export function drawingCommands(app: App): Command[] {
  const views = () => app.inDrawing && !!app.store.doc.drawing?.views.length;
  const members = () => !app.assembly && app.weldments.length > 0;
  const sheetMetal = () => !app.assembly && !!app.bbox && app.store.doc.features.some((f) => f.type === 'baseFlange');
  return [
    {
      id: 'drawing:balloon', label: 'Balloon', icon: 'balloon', keywords: 'drawing item number bill of materials bom cut list annotate',
      description: 'Label a component (or a structural member) with its item number from the bill of materials (or the cut list).',
      enabled: () => views() && (!!app.assembly || members()), checked: () => app.inDrawing && app.drawing.tool?.kind === 'balloon',
      run: () => app.drawing.startTool('balloon'),
    },
    {
      id: 'drawing:autoBalloon', label: 'Auto Balloon', icon: 'autoBalloon', keywords: 'drawing balloons item numbers bill of materials bom',
      description: 'Add a balloon to every component a view shows, numbered from the bill of materials.',
      enabled: () => views() && !!app.assembly, checked: () => app.inDrawing && app.drawing.tool?.kind === 'autoBalloon',
      run: () => app.drawing.startTool('autoBalloon'),
    },
    {
      id: 'drawing:bom', label: 'Bill of Materials', icon: 'drawingBom', keywords: 'drawing bom parts list table quantity',
      description: 'Put the assembly’s bill of materials on the sheet: item number, part, material and quantity. It follows the assembly.',
      enabled: () => app.inDrawing && !!app.assembly, run: () => app.drawing.addTable('bom'),
    },
    {
      id: 'drawing:cutList', label: 'Cut List', icon: 'cutList', keywords: 'drawing weldment table lengths angles members',
      description: 'Put the weldment’s cut list on the sheet: item, quantity, description, length and end angles. It follows the part.',
      enabled: () => app.inDrawing && members(), run: () => app.drawing.addTable('cutList'),
    },
    {
      id: 'drawing:flat', label: 'Flat Pattern', icon: 'drawingFlat', keywords: 'drawing sheet metal flat pattern unfold bend lines',
      description: 'Add a view of the sheet metal part’s flat pattern, with bend lines, bend notes and its overall size.',
      enabled: () => app.inDrawing && sheetMetal(), run: () => void app.drawing.addFlatView(),
    },
  ];
}
