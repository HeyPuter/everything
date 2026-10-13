/**
 * Project details, shown when nothing is selected: name, canvas settings
 * (shared with the project settings dialog) and a summary.
 */
import { h, announce } from '../../lib/dom.js';
import { clock } from '../../lib/time.js';
import { allClips } from '../../model/timeline.js';
import { RATIOS } from '../../model/project.js';
import { projectSettingsFields } from '../project-settings.js';
import { segmented } from '../controls.js';
import { PROXY_MODES, proxyMode, canProxy } from '../../model/proxy.js';
import { formatBytes } from '../../model/bins.js';
import { createScope, propSection, uidFor } from './common.js';
import { icon } from '../../lib/icons.js';
import { ensureTimelines, renameTimeline } from '../../model/timelines.js';
import { menuButton } from '../menu.js';
import '../../styles/proxy.css';

const MODE_HINT = {
  off: 'The preview always plays the original files.',
  on: 'Every video larger than 720p, or with a high bitrate, gets a proxy.',
  auto: 'Proxies are made for 4K, high bitrate or high frame rate videos, and for videos that play back slowly on this device.',
};

/** One line on the project's proxies: "2 ready, 1 being made (40%)". */
export function proxySummary(project, proxies) {
  if (!proxies) return '';
  const seen = new Set();
  let ready = 0;
  let size = 0;
  let waiting = 0;
  let failed = 0;
  let making = null;
  for (const a of Object.values(project.assets)) {
    if (!canProxy(a) || seen.has(a.hash)) continue;
    seen.add(a.hash);
    const st = proxies.status(a);
    if (st.state === 'ready') {
      ready++;
      size += st.size;
    } else if (st.state === 'generating') making = st.progress;
    else if (st.state === 'queued') waiting++;
    else if (st.state === 'error') failed++;
  }
  const parts = [];
  if (ready) parts.push(`${ready} ready${size ? ` (${formatBytes(size)})` : ''}`);
  if (making !== null) parts.push(`1 being made (${Math.round(making * 100)}%)`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (failed) parts.push(`${failed} failed`);
  return parts.length ? `Proxies: ${parts.join(', ')}.` : seen.size ? 'No proxies yet.' : 'No videos in this project.';
}

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

  // Proxy media: small copies of heavy videos for a smooth preview.
  const modeCtl = segmented({
    label: 'Proxy media',
    options: PROXY_MODES,
    value: proxyMode(store.project),
    onChange: (v) => {
      actions.setProxyMode(v);
      announce(`Proxy media ${PROXY_MODES.find((m) => m.value === v).label}`);
    },
    className: 'proxy-mode',
  });
  const hint = h('p.proxy-hint');
  const status = h('p.proxy-status', { role: 'status' });
  const proxyBody = h('div.proxy-settings',
    h('div.field.insp-row', h('span.field-label', 'Use proxies'), h('div.insp-row-control', modeCtl.el)),
    h('p.proxy-hint', 'Proxies are small copies of your videos that play smoothly while you edit. They stay on this device; exports always use the original files.'),
    hint,
    status,
  );
  scope.bind(() => {
    const mode = proxyMode(store.project);
    modeCtl.set(mode);
    hint.textContent = MODE_HINT[mode];
    status.textContent = proxySummary(store.project, ctx.proxies);
    status.hidden = !ctx.proxies || !status.textContent;
  });
  scope.update();

  const el = h('div.project-view',
    propSection('Project', [h('div.field.insp-row', h('label.field-label', { for: nameId }, 'Name'), h('div.insp-row-control', name)), info]),
    propSection('Timeline', [h('div.field.insp-row', h('label.field-label', { for: tlId }, 'Name'), h('div.insp-row-control', tlName, tlMore))]),
    propSection('Frame', settingsWrap),
    propSection('Proxy media', proxyBody),
  );
  return { el, scope };
}
