// Output Properties ▸ Post Processing: the Compositing pipeline toggle (render.use_compositing)
// and dithering, appended to the Output tab without changing its module. When another module
// (the Video Sequencer) already contributes a "Post Processing" panel, its rows are merged into
// this one so the tab shows a single panel.
import { h, type Child, type VNode } from '../ui/h';
import { app } from '../app/app';
import { panel } from '../ui/widgets';
import { bool, num, splitRow } from '../ui/props';
import { propertiesTabs } from '../editors/properties/properties';
import { compositingGroup } from './data';

const PANEL_ID = 'out-post';

/** Remove (and return) another module's Post Processing panel from a drawn tab. */
function extract(c: Child, found: VNode[]): Child {
  if (Array.isArray(c)) return c.map((x) => extract(x as Child, found));
  const v = c as VNode | null;
  if (v && typeof v === 'object' && v.tag === 'section' && v.key === PANEL_ID) {
    found.push(v);
    return null;
  }
  return c;
}

function postProcessing(other: VNode | undefined) {
  const r = app.doc.scene.render;
  // rows of the other panel's body (when open), without its own "Pipeline" label
  const otherRows = (other?.children.find((ch) => (ch.attrs?.class as string | undefined) === 'panel-body')?.children ?? []).filter((ch) => (ch.attrs?.class as string | undefined) !== 'sub-label');
  return panel(PANEL_ID, 'Post Processing', () => [
    h('div', { class: 'sub-label' }, 'Pipeline'),
    bool(r, 'use_compositing', 'Compositing'),
    ...otherRows,
    r.use_compositing && !compositingGroup(app.doc) ? splitRow('', h('span', { class: 'prop-note' }, 'No compositing node group (Compositor ▸ New)')) : null,
    num(r, 'dither_intensity', 'Dither', { min: 0, max: 2, softMax: 2 }),
  ]);
}

function install() {
  const tab = propertiesTabs.find((t) => t.id === 'OUTPUT') as (NonNullable<(typeof propertiesTabs)[number]> & { __cmpPost?: boolean }) | undefined;
  if (!tab || tab.__cmpPost) return;
  const draw = tab.draw;
  tab.draw = (p) => {
    const found: VNode[] = [];
    const base = extract(draw(p), found);
    return [base, postProcessing(found[0])];
  };
  tab.__cmpPost = true;
}

// install after every module wrapped the tab (so other Post Processing panels can be merged)
setTimeout(install, 0);
