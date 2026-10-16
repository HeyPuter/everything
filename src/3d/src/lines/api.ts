// Scripting: bpy.data.linestyles, view_layer.use_freestyle / freestyle_settings (line sets with
// new() / remove()), line style modifier lists (new(name, type) / remove()), and the Line Art
// modifier fields through the generic modifier wrappers.
import { app } from '../app/app';
import { uid } from '../data/defaults';
import { NEW_DATA, NEW_PARAMS, addDataCollection, viewLayer } from '../scripting/api';
import { arrayFactories, proxify, Struct, touched, pyError, type Raw } from '../scripting/rna';
import { addLineStyle, freestyleSettings, newLineSet, newLineStyle, newLineStyleModifier, uniqueIn, MODIFIER_TYPES, type ModifierKind } from './defaults';
import { linestyleTable } from './types';

NEW_DATA.linestyles = (name) => {
  linestyleTable(app.doc);
  return { ...newLineStyle(), id: uid('ls'), name: name || 'LineStyle' };
};
NEW_PARAMS.linestyles = ['name'];
addDataCollection('linestyles', 'FreestyleLineStyle');

Object.defineProperty(viewLayer, 'use_freestyle', {
  get: () => freestyleSettings(app.doc).use_freestyle,
  set: (v: unknown) => {
    freestyleSettings(app.doc).use_freestyle = !!v;
    touched();
  },
  enumerable: true,
});
Object.defineProperty(viewLayer, 'freestyle_settings', {
  get: () => proxify(new Struct('FreestyleSettings', () => freestyleSettings(app.doc) as unknown as Raw, 'bpy.context.view_layer.freestyle_settings')),
  enumerable: true,
});

const names = (list: unknown[]) => (list as { name?: string }[]).map((x) => x?.name ?? '');

arrayFactories.push({
  match: /freestyle_settings\.linesets$/,
  make: (a, list) => newLineSet(uniqueIn(names(list), String(a[0] ?? 'LineSet')), addLineStyle(app.doc).id),
});
for (const kind of ['color', 'alpha', 'thickness', 'geometry'] as ModifierKind[])
  arrayFactories.push({
    match: new RegExp(`linestyles\\[\\]\\.${kind}_modifiers$`),
    make: (a, list) => {
      const type = String(a[1] ?? MODIFIER_TYPES[kind][0][0]).toUpperCase();
      if (!MODIFIER_TYPES[kind].some((t) => t[0] === type)) throw pyError('TypeError', `${kind}_modifiers.new(): enum "${type}" not found in (${MODIFIER_TYPES[kind].map((t) => `'${t[0]}'`).join(', ')})`);
      return newLineStyleModifier(kind, type, uniqueIn(names(list), String(a[0] ?? type)));
    },
  });
