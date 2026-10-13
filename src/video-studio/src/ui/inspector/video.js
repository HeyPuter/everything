/**
 * Video tab for video and image clips, with Basic, Mask, Cutout, Remove,
 * Retouch and Chroma key sub-tabs.
 */
import { h, announce } from '../../lib/dom.js';
import { slider, propSection, tabSet } from './common.js';
import { transformSection, blendSection } from './transform.js';
import { appliedFilterSection } from './filter-clip.js';
import { maskTab } from './masks.js';
import { pictureSections } from './video-extras.js';
import { maskEdit } from '../mask-edit-state.js';
import { chromaTab } from './chroma.js';
import { cutoutTab } from './cutout.js';
import { retouchTab } from './retouch.js';
import { removeTab } from './removal.js';
import { removeEdit } from '../remove-edit-state.js';

/** Each side stops so at least 5% of the picture stays visible. */
const KEEP = 0.05;
const SIDES = [
  { key: 'l', label: 'Left', other: 'r' },
  { key: 't', label: 'Top', other: 'b' },
  { key: 'r', label: 'Right', other: 'l' },
  { key: 'b', label: 'Bottom', other: 't' },
];

export function cropSection(view) {
  const fields = SIDES.map((s) => slider(view, {
    label: s.label,
    min: 0,
    max: 95,
    unit: '%',
    get: (c) => Math.round((c.crop?.[s.key] || 0) * 100),
    set: (v, final) => view.edit('Crop', (c) => {
      c.crop ||= { l: 0, t: 0, r: 0, b: 0 };
      c.crop[s.key] = Math.max(0, Math.min(v / 100, 1 - KEEP - (c.crop[s.other] || 0)));
    }, { key: `crop-${s.key}`, final }),
  }));
  return propSection('Crop', fields.map((f) => f.el), {
    open: false,
    onReset: () => {
      view.edit('Reset crop', (c) => {
        c.crop = { l: 0, t: 0, r: 0, b: 0 };
      });
      announce('Crop reset');
    },
  });
}

export function basicTab(view) {
  return h('div', transformSection(view), blendSection(view), cropSection(view), appliedFilterSection(view), ...pictureSections(view));
}

const SUBS = [
  { id: 'basic', label: 'Basic', make: basicTab },
  { id: 'mask', label: 'Mask', make: maskTab },
  { id: 'cutout', label: 'Cutout', make: cutoutTab },
  { id: 'remove', label: 'Remove', make: removeTab },
  { id: 'retouch', label: 'Retouch', make: retouchTab },
  { id: 'chroma', label: 'Chroma key', make: chromaTab },
];

/** state.sub remembers the sub-tab across selections, like the top tabs. */
export function videoTab(view, state) {
  const subs = tabSet({
    label: 'Video settings',
    className: 'subtabs',
    items: SUBS,
    value: state.videoSub || 'basic',
    onChange: (id) => {
      state.videoSub = id;
      show(id);
    },
  });
  const show = (id) => {
    view.resetScope();
    subs.panel.replaceChildren(SUBS.find((s) => s.id === id).make(view));
    maskEdit.refresh();
    removeEdit.refresh();
  };
  show(subs.current);
  return h('div.video-tab', subs.list, subs.panel);
}
