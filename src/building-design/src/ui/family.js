/**
 * Create Family: turn selected masses into a component type that can be
 * placed again anywhere (and stretched through its width, depth and height).
 */
import { h } from './dom.js';
import { openDialog, toast } from './dialog.js';
import { solidsFromMasses } from '../core/families.js';
import { CATEGORIES } from '../core/catalog.js';
import { levelElevation } from '../core/model.js';
import { deleteElements, uniqueName } from '../core/ops.js';

export async function createFamilyDialog(app) {
  const doc = app.doc;
  const masses = [...app.selection].map((id) => doc.get(id)).filter((el) => el?.kind === 'mass' && el.boundary?.length >= 3);
  if (!masses.length) return toast('Model the shape with masses (Massing & Site tab), select them, then create the family.', { kind: 'error' });
  const used = new Set(doc.all('componentType').map((t) => t.category));
  const cats = CATEGORIES.filter((c) => c.model && (used.has(c.id) || c.id === 'genericModels'));
  const name = h('input.input', { type: 'text', value: uniqueName(doc.all('componentType').map((t) => t.name), 'Custom Component 1'), 'aria-label': 'Name' });
  const cat = h('select.input', { 'aria-label': 'Category' }, cats.map((c) => h('option', { value: c.id }, c.label)));
  cat.value = 'genericModels';
  const replace = h('input', { type: 'checkbox', checked: true });
  const ok = await openDialog({
    title: 'Create Family',
    size: 'sm',
    body: h(
      'div',
      h('p.dialog-text', `${masses.length} mass${masses.length === 1 ? '' : 'es'} become a component type, placed from its centre. Its width, depth and height can be changed later in Edit Type, and it stretches to fit.`),
      h('label.field', h('span.field-label', 'Name'), name),
      h('label.field', h('span.field-label', 'Category'), cat),
      h('label.check', replace, h('span', 'Replace the masses with the new component')),
    ),
    initialFocus: 'input',
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Create', primary: true, value: true },
    ],
  });
  if (!ok) return;
  const levelId = masses[0].levelId;
  const baseOf = (m) => levelElevation(doc, m.levelId) + (+m.baseOffset || 0);
  const f = solidsFromMasses(masses, baseOf);
  let type;
  app.commit('Create family', () => {
    type = doc.add({ kind: 'componentType', family: 'custom', familyName: 'Custom', category: cat.value, name: name.value.trim() || 'Custom Component', width: Math.round(f.width), depth: Math.round(f.depth), height: Math.round(f.height), baseWidth: f.width, baseDepth: f.depth, baseHeight: f.height, solids: f.solids });
    if (replace.checked) {
      deleteElements(doc, masses.map((m) => m.id));
      const el = doc.add({ kind: 'component', typeId: type.id, levelId, at: f.center, rotation: 0, offset: f.base - levelElevation(doc, levelId) });
      app.select([el.id]);
    }
  });
  app.setCurrentType('component', type.id);
  toast(`Created ${type.name}. Place more with Component.`, { kind: 'success' });
}
