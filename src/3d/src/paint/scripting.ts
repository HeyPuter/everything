// Scripting for the paint modes: bpy.data.palettes (with `colors.new()` / `remove()`) and
// bpy.data.paint_curves.
import { app } from '../app/app';
import { NEW_DATA, addDataCollection } from '../scripting/api';
import { arrayFactories } from '../scripting/rna';
import { palettesOf } from './palette';
import { paintCurvesOf } from './paintcurve';
import { uid } from '../data/defaults';
import { paletteColor } from './palettemath';

NEW_DATA.palettes = (name) => {
  palettesOf(app.doc);
  return { id: uid('pal'), name: name || 'Palette', colors: [], active_index: -1 };
};
addDataCollection('palettes', 'Palette');
arrayFactories.push({ match: /^bpy\.data\.palettes\[\]\.colors$/, make: () => paletteColor([0, 0, 0]) });

NEW_DATA.paint_curves = (name) => {
  paintCurvesOf(app.doc);
  return { id: uid('pc'), name: name || 'PaintCurve', points: [], add_index: -1 };
};
addDataCollection('paint_curves', 'PaintCurve');
