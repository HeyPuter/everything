/**
 * Details panel (right): properties of the selection, with top tabs per
 * clip type (Video, Audio, Speed, Animation, Effects, Style, Color; Text,
 * Speech; Avatar; ...), the
 * selected transition, several clips, or the project when nothing is
 * selected.
 *
 * The DOM is rebuilt only when what is shown changes (another clip, a clip
 * type, a tab). Edits, undo/redo and playhead moves update the controls in
 * place through the view's updaters.
 */
import '../../styles/inspector.css';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clipLabel } from '../../model/timeline.js';
import { createClipView, tabSet, note } from './common.js';
import { videoTab } from './video.js';
import { audioTab } from './audio.js';
import { speedTab } from './speed.js';
import { voiceTab } from './voice.js';
import { animationTab } from './animation.js';
import { adjustTab } from './adjust.js';
import { textTab } from './text.js';
import { speechTab } from './text-speech.js';
import { stickerTab } from './sticker.js';
import { effectTab } from './effect.js';
import { clipEffectsTab } from './clip-effects.js';
import { filterClipTab } from './filter-clip.js';
import { transitionView } from './transition.js';
import { projectView } from './project.js';
import { multiView } from './multi.js';
import { compoundTab } from './compound.js';
import { multicamTab } from './multicam.js';
import { avatarTab } from './avatar.js';
import { stylizeTab } from './stylize.js';
import { angleTracks } from '../../model/multicam.js';
import { maskEdit } from '../mask-edit-state.js';

const TABS = {
  video: { label: 'Video', make: videoTab },
  audio: { label: 'Audio', make: audioTab },
  voice: { label: 'Voice', make: voiceTab },
  speed: { label: 'Speed', make: speedTab },
  animation: { label: 'Animation', make: animationTab },
  adjust: { label: 'Color', make: adjustTab },
  text: { label: 'Text', make: textTab },
  speech: { label: 'Speech', make: speechTab },
  sticker: { label: 'Graphic', make: stickerTab },
  effect: { label: 'Effect', make: effectTab },
  clipfx: { label: 'Effects', make: clipEffectsTab },
  filter: { label: 'Filter', make: filterClipTab },
  compound: { label: 'Compound', make: compoundTab },
  multicam: { label: 'Angles', make: multicamTab },
  avatar: { label: 'Avatar', make: avatarTab },
  stylize: { label: 'Style', make: stylizeTab },
};

/** Tab label; the audio clip's own tab reads Basic next to Voice and Speed. */
function tabLabel(id, type) {
  if (id === 'video' && type === 'image') return 'Image';
  if (id === 'audio' && type === 'audio') return 'Basic';
  return TABS[id].label;
}

const TYPE_ICONS = { video: 'film', image: 'image', audio: 'music', text: 'text', sticker: 'sticker', avatar: 'avatar', effect: 'effects', filter: 'filters', adjust: 'adjust' };

/** Top tabs for a clip: its own properties first, then timing, motion and color. */
export function tabsFor(project, clip) {
  switch (clip.type) {
    case 'video': {
      const a = project.assets[clip.assetId];
      return ['video', ...(a?.hasAudio ? ['audio'] : []), ...(clip.freeze ? [] : ['speed']), 'animation', 'clipfx', 'stylize', 'adjust'];
    }
    case 'image':
      return ['video', 'animation', 'clipfx', 'stylize', 'adjust'];
    case 'audio':
      return ['audio', 'voice', 'speed'];
    case 'text':
      return ['text', 'animation', 'clipfx', 'speech'];
    case 'sticker':
      return ['sticker', 'animation', 'clipfx'];
    case 'avatar':
      return ['avatar', 'animation', 'clipfx'];
    case 'effect':
      return ['effect'];
    case 'filter':
      return ['filter'];
    case 'adjust':
      return ['adjust'];
    case 'compound':
      return [...(clip.multicam ? ['multicam'] : []), 'compound', 'animation'];
    default:
      return [];
  }
}

export function createInspector(ctx) {
  const { store } = ctx;
  // Last tab and sub-tabs used, per clip type, so the next clip opens there.
  const state = { tabs: {}, videoSub: 'basic', animSub: null };
  const title = h('h2.panel-title', 'Details');
  const headTabs = h('div.insp-head-tabs');
  const body = h('div.inspector-body', { tabindex: '-1' });
  const el = h('section.panel.inspector', { 'aria-label': 'Details' }, h('div.panel-head', title, headTabs), body);

  let key = null;
  let current = null;

  function viewKey() {
    if (store.transition) return `tr:${store.transition}`;
    const ids = store.selectedIds;
    if (ids.length > 1) return `multi:${ids.join(',')}`;
    const s = store.selected;
    if (!s) return 'project';
    // A multi-camera clip's cards follow its angles.
    const angles = s.clip.multicam ? `:${angleTracks(s.clip).length}` : '';
    return `clip:${s.clip.id}:${s.clip.type}:${tabsFor(store.project, s.clip).join(',')}${angles}`;
  }

  function setTitle(text, { hidden = false } = {}) {
    title.textContent = text;
    title.classList.toggle('sr-only', hidden);
  }

  function buildProject() {
    setTitle('Details');
    headTabs.replaceChildren();
    const v = projectView(ctx);
    body.replaceChildren(v.el);
    return { update: () => v.scope.update(), tick() {} };
  }

  function buildMulti() {
    setTitle('Multiple clips');
    headTabs.replaceChildren();
    const v = multiView(ctx);
    body.replaceChildren(v.el);
    return { update: () => v.scope.update(), tick() {} };
  }

  function buildTransition(clipId) {
    setTitle('Transition');
    headTabs.replaceChildren();
    const view = createClipView(ctx, clipId);
    body.replaceChildren(transitionView(view));
    return { update: () => view.scope.update(), tick() {} };
  }

  function buildClip(found) {
    const clip = found.clip;
    const type = clip.type;
    const view = createClipView(ctx, clip.id);
    const ids = tabsFor(store.project, clip);
    const items = ids.map((id) => ({ id, label: tabLabel(id, type) }));
    const ts = tabSet({
      label: 'Clip properties',
      className: 'top-tabs',
      items,
      value: state.tabs[type],
      onChange: (id) => {
        state.tabs[type] = id;
        show(id);
      },
    });
    const lockNote = note('This track is locked. Unlock it on the timeline to edit the clip.', 'lock');
    const show = (id) => {
      view.resetScope();
      ts.panel.replaceChildren(TABS[id].make(view, state));
      body.scrollTop = 0;
      maskEdit.refresh();
    };
    const head = h('span.insp-clip-icon', { 'aria-hidden': 'true' }, icon(clip.multicam ? 'multicam' : TYPE_ICONS[type] || 'film', 14));
    headTabs.replaceChildren(head, ts.list);
    setTitle(clipLabel(store.project, clip), { hidden: true });
    body.replaceChildren(lockNote, ts.panel);
    show(ts.current);
    const update = () => {
      const f = view.found;
      if (!f) return;
      lockNote.hidden = !f.track.locked;
      title.textContent = clipLabel(store.project, f.clip);
      view.scope.update();
    };
    update();
    return {
      update,
      tick: () => view.scope.tick(),
      selectTab(id, { force = false } = {}) {
        if (!ids.includes(id) || (ts.current === id && !force)) return;
        ts.select(id);
        state.tabs[type] = id;
        show(id);
      },
    };
  }

  function sync() {
    const k = viewKey();
    if (k === key && current) {
      current.update();
      return;
    }
    const hadFocus = el.contains(document.activeElement);
    key = k;
    body.scrollTop = 0;
    if (k === 'project') current = buildProject();
    else if (k.startsWith('multi:')) current = buildMulti();
    else if (k.startsWith('tr:')) current = buildTransition(store.transition);
    else current = buildClip(store.selected);
    // Keep keyboard focus in the panel when its content is replaced under it.
    if (hadFocus && !el.contains(document.activeElement)) (headTabs.querySelector('[role=tab][aria-selected=true]') || body).focus();
  }

  sync();
  const offs = [
    store.on('select', sync),
    store.on('change', sync),
    store.on('time', () => current?.tick()),
  ];
  // Proxy progress shows in the project details.
  if (ctx.proxies) offs.push(ctx.proxies.on('change', () => key === 'project' && current?.update()));

  return {
    el,
    /** Show a top tab of the selected clip (e.g. 'clipfx' after adding an effect to it). */
    showTab(id) {
      sync();
      current?.selectTab?.(id);
    },
    /** Show a sub-tab of the Video tab (e.g. 'cutout'). */
    showVideoSub(sub) {
      state.videoSub = sub;
      sync();
      current?.selectTab?.('video', { force: true });
    },
    /** Open the Text tab and put the caret in the text box (double-click on a text clip in the player). */
    focusText() {
      const s = store.selected;
      if (!s || s.clip.type !== 'text') return false;
      sync();
      current.selectTab?.('text');
      const ta = body.querySelector('.insp-textarea');
      if (!ta) return false;
      ta.focus();
      ta.select();
      return true;
    },
    dispose: () => offs.forEach((f) => f()),
  };
}
