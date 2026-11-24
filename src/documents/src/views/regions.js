/**
 * F6 and Shift+F6 move the keyboard between the editor's areas, as in Word: the title bar, the ribbon, a message
 * above the document, the panes beside it and the document itself in the order they sit, and the status bar. Each
 * area is entered where its keyboard starts: the ribbon at its chosen tab, the document at its caret, the others at
 * their first control. Areas that are hidden, or have nothing to focus, are passed over. Notices with a button come last.
 */

const TABBABLE = 'a[href], button, input, select, textarea, iframe, [tabindex]';

const shown = node => !!node && node.getClientRects().length > 0 && !node.closest('[hidden], [inert]');

function firstTabbable(area) {
  return [...area.querySelectorAll(TABBABLE)].find(node => node.tabIndex >= 0 && !node.disabled && shown(node)) || null;
}

/** The areas of the editor `root` in order, each { nodes, enter }: `enter` focuses it, or returns false when it can't. */
export function editorRegions(root, { focusDocument }) {
  const one = selector => [...root.querySelectorAll(selector)].filter(shown);
  const enterFirst = nodes => () => {
    for (const node of nodes) { const target = firstTabbable(node); if (target) { target.focus(); return true; } }
    return false;
  };
  const regions = [];
  const add = (nodes, enter = enterFirst(nodes)) => { if (nodes.length) regions.push({ nodes, enter }); };
  add(one('.ed-titlebar'));
  const ribbon = one('.ribbon-tabs, .ed-ribbon');
  add(ribbon, () => {
    const tab = ribbon[0]?.querySelector('.ribbon-tab[aria-selected="true"]');
    if (tab && shown(tab)) { tab.focus(); return true; }
    return enterFirst(ribbon)();
  });
  for (const message of one(':scope > .canvas-message, :scope > .cl-banner')) add([message]);
  const body = root.querySelector('.canvas-editor-body');
  const areas = body ? [...body.querySelectorAll(':scope > .canvas-navigation, :scope > .canvas-editor-content > *')] : [];
  for (const area of areas.filter(shown)) {
    if (area.classList.contains('canvas-document-surface')) add([area], () => { focusDocument(); return true; });
    else add([area]);
  }
  add(one('.ed-statusbar'));
  // A notice with something to do in it (Undo, Cancel printing, Save a Copy) is the last area, as Word's message
  // bars are one: its button was out of the keyboard's reach.
  add([...root.ownerDocument.querySelectorAll('.toast-root > .toast:not(.leaving)')].filter(toast => shown(toast) && firstTabbable(toast)));
  return regions;
}

/** Moves focus to the next area (`step` 1) or the previous one (-1) after the one holding it; false when none takes it. */
export function cycleRegions(root, { step = 1, focusDocument }) {
  const regions = editorRegions(root, { focusDocument });
  if (!regions.length) return false;
  const active = root.ownerDocument.activeElement;
  let at = regions.findIndex(region => region.nodes.some(node => node.contains(active)));
  // Nowhere in particular (the page itself): as if from the document.
  if (at < 0) at = Math.max(0, regions.findIndex(region => region.nodes[0].classList.contains('canvas-document-surface')));
  for (let i = 1; i <= regions.length; i++) {
    const region = regions[(at + step * i + regions.length * i) % regions.length];
    if (region.enter()) return true;
  }
  return false;
}
