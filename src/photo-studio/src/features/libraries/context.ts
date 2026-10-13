// What the "+" menu of the Libraries panel can add right now (enabled checks
// for the add commands). Cheap checks only; the capture code is in apply.ts.
import type { Editor } from '../../editor';
import type { ItemType } from './model';

export type AddSource = 'foreground' | 'background' | 'gradient' | 'pattern' | 'layer-style' | 'character-style' | 'paragraph-style' | 'brush' | 'layers' | 'selection';
export const ADD_SOURCES: [AddSource, string, ItemType][] = [
  ['foreground', 'Foreground Color', 'color'],
  ['background', 'Background Color', 'color'],
  ['gradient', 'Current Gradient', 'gradient'],
  ['pattern', 'Current Pattern', 'pattern'],
  ['layer-style', 'Layer Style of Selected Layer', 'layer-style'],
  ['character-style', 'Character Style of Text', 'character-style'],
  ['paragraph-style', 'Paragraph Style of Text', 'paragraph-style'],
  ['brush', 'Current Brush', 'brush'],
  ['layers', 'Selected Layers as Graphic', 'graphic'],
  ['selection', 'Selection as Graphic', 'graphic'],
];
export function canAdd(e: Editor, src: AddSource): boolean {
  switch (src) {
    case 'foreground':
    case 'background':
    case 'gradient':
    case 'pattern':
    case 'brush':
      return true;
    case 'layer-style':
      return !!e.layer?.style && Object.keys(e.layer.style).length > 0;
    case 'character-style':
    case 'paragraph-style':
      return e.hasDocument && e.layer?.kind === 'text';
    case 'layers':
      return e.hasDocument && e.selectedLayers.length > 0;
    case 'selection':
      return e.hasDocument && !!e.doc.selection;
  }
}
