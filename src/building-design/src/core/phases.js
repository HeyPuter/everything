/**
 * Phases: the construction sequence of a project (for example Existing,
 * then New Construction). Every model element is created in a phase and may
 * be demolished in a later one. A view shows the model as of its phase,
 * through a phase filter that decides how existing, demolished and new
 * elements look.
 *
 *   phase    { name, order }
 *   element  { phaseId, demolishedId }      (no phaseId: the last phase)
 *   view     { phaseId, phaseFilter }       (no phaseId: the last phase)
 */

export const PHASE_FILTERS = [
  { value: 'all', label: 'Show All', desc: 'Existing elements halftone, demolished dashed, new normal' },
  { value: 'complete', label: 'Show Complete', desc: 'Everything that stands at the end of the phase' },
  { value: 'new', label: 'Show New', desc: 'Only what is built in this phase' },
  { value: 'previousNew', label: 'Show Previous + New', desc: 'Existing halftone and new, without demolition' },
  { value: 'previousDemo', label: 'Show Previous + Demo', desc: 'Existing halftone and demolished dashed' },
  { value: 'none', label: 'None', desc: 'No phase graphics' },
];

/** How each phase status looks under each filter: 'normal' | 'halftone' | 'dashed' | 'hidden'. */
const RULES = {
  all: { existing: 'halftone', demolished: 'dashed', new: 'normal' },
  complete: { existing: 'normal', demolished: 'hidden', new: 'normal' },
  new: { existing: 'hidden', demolished: 'hidden', new: 'normal' },
  previousNew: { existing: 'halftone', demolished: 'hidden', new: 'normal' },
  previousDemo: { existing: 'halftone', demolished: 'dashed', new: 'hidden' },
  none: { existing: 'normal', demolished: 'normal', new: 'normal' },
};

export function phasesInOrder(doc) {
  return doc.all('phase').sort((a, b) => (+a.order || 0) - (+b.order || 0));
}

/** Index of a phase (missing or unknown ids count as the last phase). */
function orderOf(phases, id) {
  const i = phases.findIndex((p) => p.id === id);
  return i < 0 ? phases.length - 1 : i;
}

/**
 * Status of an element in a view's phase: 'existing' (built earlier and still
 * standing), 'new' (built in this phase), 'demolished' (taken down in this
 * phase), or null when it does not exist at that time.
 */
export function phaseStatus(doc, view, el, phases = phasesInOrder(doc)) {
  if (phases.length < 2 || !el) return 'new';
  const v = orderOf(phases, view?.phaseId);
  const c = orderOf(phases, el.phaseId);
  if (c > v) return null;
  if (el.demolishedId) {
    const d = orderOf(phases, el.demolishedId);
    if (d < v) return null;
    if (d === v) return 'demolished';
  }
  return c === v ? 'new' : 'existing';
}

/** How an element looks in a view because of phasing. */
export function phaseLook(doc, view, el, phases) {
  const st = phaseStatus(doc, view, el, phases);
  if (st === null) return 'hidden';
  const rules = RULES[view?.phaseFilter || 'all'] || RULES.all;
  return rules[st] || 'normal';
}

/** Model elements take part in phasing; annotations and views do not. */
export function phased(el) {
  return !!el && !el.viewId && !el.kind.endsWith('Type') && !['level', 'grid', 'refPlane', 'material', 'project', 'phase', 'viewFilter', 'viewTemplate', 'revision', 'group', 'viewport', 'room', 'area', 'areaBoundary', 'roomSeparator', 'link', 'workset', 'syncEntry', 'projectParam', 'optionSet', 'designOption', 'space', 'zone', 'globalParam', 'basePoint', 'scopeBox', 'importedModel'].includes(el.kind) && !el.kind.match(/^(plan|ceilingPlan|areaPlan|view3d|elevation|section|drafting|legend|schedule|sheet)$/);
}

/** Default phases for a new project. */
export function defaultPhases() {
  return [
    { id: 'phase-existing', kind: 'phase', name: 'Existing', order: 1 },
    { id: 'phase-new', kind: 'phase', name: 'New Construction', order: 2 },
  ];
}
