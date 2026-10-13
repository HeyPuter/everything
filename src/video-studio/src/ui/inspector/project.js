/**
 * Project details, shown when nothing is selected: name, canvas settings
 * (shared with the project settings dialog) and a summary.
 */
import { h, announce } from '../../lib/dom.js';
import { clock } from '../../lib/time.js';
import { allClips } from '../../model/timeline.js';
import { RATIOS } from '../../model/project.js';
import { projectSettingsFields } from '../project-settings.js';
import { createScope, propSection, uidFor } from './common.js';
import { icon } from '../../lib/icons.js';
import { ensureTimelines, renameTimeline } from '../../model/timelines.js';
import { menuButton } from '../menu.js';

export function projectView(ctx) {
  const { store, actions } = ctx;
  const scope = createScope();
  const nameId = uidFor('pname');
  const name = h('input.input', { id: nameId, type: 'text', maxLength: 200, value: store.project.name, spellcheck: false });
  const commitName = () => {
    const v = name.value.trim();
    if (!v) {
      name.value = store.project.name;
      return;
    }
    if (v !== store.project.name) {
      actions.renameProject(v);
      announce(`Project renamed to ${v}`);
    }
  };
  name.addEventListener('change', commitName);
  name.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitName();
      name.blur();
    } else if (e.key === 'Escape') {
      name.value = store.project.name;
      name.blur();
    }
  });

  // The open timeline's name (a project can hold several timelines).
  const tlId = uidFor('tlname');
  const tlName = h('input.input', { id: tlId, type: 'text', maxLength: 80, spellcheck: false });
  const tlCurrent = () => ctx.timelines?.active().name || 'Timeline 1';
  tlName.value = tlCurrent();
  const commitTimelineName = () => {
    const v = tlName.value.trim();
    if (!v || v === tlCurrent()) {
      tlName.value = tlCurrent();
      return;
    }
    store.update('Rename timeline', (p) => {
      ensureTimelines(p);
      return renameTimeline(p, p.timelineId, v);
    }, { structural: false });
    announce(`Timeline renamed to ${v}`);
  };
  tlName.addEventListener('change', commitTimelineName);
  tlName.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTimelineName();
      tlName.blur();
    } else if (e.key === 'Escape') {
      tlName.value = tlCurrent();
      tlName.blur();
    }
  });
  const tlMore = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Timelines', 'data-tip': 'Timelines' }, icon('timelines', 16));
  menuButton(tlMore, () => ctx.timelines?.menuItems() || [], { align: 'end', label: 'Timelines' });

  // The shared settings fields don't update themselves, so they are rebuilt
  // when the settings change from elsewhere (undo, the dialog), unless the
  // user is working in them.
  const settingsWrap = h('div.project-settings');
  let settingsSig = '';
  const fillSettings = () => {
    const sig = JSON.stringify(store.project.settings);
    if (sig === settingsSig || settingsWrap.contains(document.activeElement)) return;
    settingsSig = sig;
    settingsWrap.replaceChildren(projectSettingsFields(ctx));
  };
  fillSettings();
  settingsWrap.addEventListener('focusout', (e) => {
    if (!settingsWrap.contains(e.relatedTarget)) fillSettings();
  });

  const dd = {};
  const info = h('dl.insp-kv', ['Duration', 'Frame', 'Clips', 'Media'].map((k) => [h('dt', k), (dd[k] = h('dd'))]));

  scope.bind(() => {
    const p = store.project;
    if (document.activeElement !== name && name.value !== p.name) name.value = p.name;
    if (document.activeElement !== tlName && tlName.value !== tlCurrent()) tlName.value = tlCurrent();
    fillSettings();
    const s = p.settings;
    const ratio = RATIOS.find((r) => r.id === s.ratio)?.label || (s.ratio === 'original' ? 'Original' : 'Custom');
    dd.Duration.textContent = clock(store.duration);
    dd.Frame.textContent = `${s.width} x ${s.height}, ${ratio}, ${s.fps} fps`;
    dd.Clips.textContent = String(allClips(p).length);
    dd.Media.textContent = String(Object.keys(p.assets).length);
  });
  scope.update();

  const el = h('div.project-view',
    propSection('Project', [h('div.field.insp-row', h('label.field-label', { for: nameId }, 'Name'), h('div.insp-row-control', name)), info]),
    propSection('Timeline', [h('div.field.insp-row', h('label.field-label', { for: tlId }, 'Name'), h('div.insp-row-control', tlName, tlMore))]),
    propSection('Frame', settingsWrap),
  );
  return { el, scope };
}
