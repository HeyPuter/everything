/**
 * The editing workspace: title bar, assets panel, player, details panel and
 * timeline, with resizable splits, global shortcuts and autosave.
 */
import { h, announce, clamp } from '../lib/dom.js';
import { appIcon } from '../lib/icons.js';
import { timecode } from '../lib/time.js';
import { EditorStore } from '../model/store.js';
import { AutoSaver } from '../storage/library.js';
import { Player } from '../engine/player.js';
import { MediaService } from '../media/media-service.js';
import { ProxyManager } from '../media/proxy-manager.js';
import { proxyMode } from '../model/proxy.js';
import { syncProjectFonts } from '../media/fonts.js';
import { createActions } from './actions.js';
import { createTimelineActions } from './timeline-actions.js';
import { createCommands } from './commands.js';
import { createTopbar, LAYOUTS } from './topbar.js';
import { createAssetsPanel } from './panels/index.js';
import { createInspector } from './inspector/index.js';
import { createPlayerView } from './player-view.js';
import { createTimeline } from './timeline/timeline.js';
import { createMobileChrome } from './mobile.js';
import { openExportDialog } from './export-dialog.js';
import { openVoiceoverDialog } from './voiceover-dialog.js';
import { openProjectSettings } from './project-settings.js';
import { openDialog, toast, installTooltips } from './dialog.js';
import { openShortcutsDialog } from './shortcuts-dialog.js';
import { createHistoryPanel } from './history-panel.js';
import { createReviewPanel } from './review/review-panel.js';
import { createEditAssistant } from './edit-assistant.js';
import { openPreferences, pref, onPrefsChange } from './preferences-dialog.js';
import { prefs, setPref } from './prefs.js';

export class Editor {
  constructor(root, { library, project, account, onExit, onNewProject, onOpenProject }) {
    this.root = root;
    this.library = library;
    const store = new EditorStore(project, { toggles: prefs().toggles });
    this.store = store;
    store.on('toggles', () => setPref('toggles', { ...store.toggles }));
    this.saver = new AutoSaver(library, store);
    this.media = new MediaService(library);
    // Proxy media for heavy footage: a device cache, remembered lists in the preferences.
    this.proxies = new ProxyManager({ library, memory: { get: () => prefs().proxyMemory, set: (v) => setPref('proxyMemory', v) } });
    this.media.proxies = this.proxies;
    // Uploaded fonts are registered with the browser before text draws with them.
    syncProjectFonts(library, project);

    const ctx = {
      editor: this,
      store,
      library,
      media: this.media,
      proxies: this.proxies,
      saver: this.saver,
      account,
      exitToHome: () => this.exit(),
      newProject: () => this.exit({ create: true }),
      openProject: onOpenProject ? (id) => this.exit({ open: id }) : null,
      openScriptVideo: () => import('./script-video.js').then((m) => m.openScriptVideo(ctx)),
      openHighlights: () => import('./highlights-dialog.js').then((m) => m.openHighlights(ctx)),
      openExport: () => {
        // Exports cover the whole project, so leave any compound clip being edited.
        while (store.nest?.length) store.closeCompound();
        return openExportDialog(ctx);
      },
      openVoiceover: () => openVoiceoverDialog(ctx),
      openShortcuts: () => this.openShortcuts(),
      openProjectSettings: () => openProjectSettings(ctx),
      openAbout: () => this.openAbout(),
      openImport: () => ctx.assets?.openImport(),
      applyLayout: (id) => this.applyLayout(id),
      openPreferences: () => openPreferences(ctx),
      toggleLoop: () => {
        setPref('loopPlayback', !pref('loopPlayback'));
        ctx.player.loop = pref('loopPlayback');
        announce(ctx.player.loop ? 'Loop playback on' : 'Loop playback off');
      },
      openCrop: (id) => import('./crop-dialog.js').then((m) => m.openCropDialog(ctx, id)),
      openTracking: (id) => import('./tracking-dialog.js').then((m) => m.openTrackingDialog(ctx, id)),
      openShareReview: () => {
        while (store.nest?.length) store.closeCompound();
        return import('./review/share-dialog.js').then((m) => m.openShareDialog(ctx));
      },
      exportStill: () => this.exportStill(),
      snapshotToMedia: () => this.exportStill({ toMedia: true }),
      saveNow: async () => {
        await this.saver.save();
        announce('Saved');
      },
    };
    this.ctx = ctx;
    this.onExit = onExit;
    this.onNewProject = onNewProject;
    this.onOpenProject = onOpenProject;
    ctx.actions = createActions(ctx);
    ctx.timelines = createTimelineActions(ctx);
    ctx.commands = createCommands(ctx);

    // Player canvas is created up front so the engine exists before views mount.
    const canvas = h('canvas.player-canvas', { 'aria-hidden': 'true' });
    ctx.player = new Player({ store, library, canvas, proxies: this.proxies });
    ctx.player.canvas = canvas;
    ctx.player.loop = pref('loopPlayback');
    this._offPrefs = onPrefsChange(() => (ctx.player.loop = pref('loopPlayback')));
    if (!ctx.player.supported) toast('Your browser does not support WebGL2, so the preview is unavailable. Export still needs WebGL2 too.', { kind: 'error', duration: 10000 });

    const topbar = createTopbar(ctx);
    ctx.assets = createAssetsPanel(ctx);
    ctx.playerView = createPlayerView(ctx);
    ctx.inspector = createInspector(ctx);
    ctx.timeline = createTimeline(ctx);

    const p = prefs();
    this.el = h('div.editor', { style: { '--left-w': `${p.leftW}px`, '--right-w': `${p.rightW}px`, '--upper': String(p.upperH) } },
      topbar.el,
      h('main#main.workspace', { tabindex: '-1' },
        h('h1.sr-only', `${project.name} - Video Studio editor`),
        h('div.upper',
          ctx.assets.el,
          this._resizer('v', 'left'),
          ctx.playerView.el,
          this._resizer('v', 'right'),
          ctx.inspector.el,
        ),
        this._resizer('h', 'upper'),
        ctx.timeline.el,
      ),
    );
    ctx.history = createHistoryPanel(ctx);
    this.el.append(ctx.history.el);
    ctx.review = createReviewPanel(ctx);
    this.el.append(ctx.review.el);
    ctx.mobile = createMobileChrome(ctx, this.el);
    ctx.assistant = createEditAssistant(ctx);
    ctx.timeline.el.append(ctx.assistant.launcher);
    this.el.append(ctx.assistant.el);
    root.replaceChildren(this.el);
    root.removeAttribute('aria-busy');
    installTooltips(this.el);

    this._onKey = (e) => this.onKey(e);
    document.addEventListener('keydown', this._onKey);
    this._onUnload = (e) => {
      if (store.dirty || library.pendingUploads) {
        this.saver.save();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', this._onUnload);
    // Inside the Puter desktop, save before the window closes.
    if (typeof puter !== 'undefined' && puter.env === 'app' && puter.ui?.onWindowClose) {
      puter.ui.onWindowClose(async () => {
        await this.saver.flush().catch(() => {});
        await library.flushUploads().catch(() => {});
        puter.exit();
      });
    }
    ctx.playerView.mounted?.();
    ctx.timeline.mounted?.();
    document.title = `${project.name} - Video Studio`;
    store.on('change', () => (document.title = `${store.project.name} - Video Studio`));
    this._coverTimer = null;
    store.on('change', () => this._scheduleCover());
    this._watchProxies();
  }

  _resizer(dir, which) {
    const label = which === 'upper' ? 'Resize timeline' : which === 'left' ? 'Resize media panel' : 'Resize details panel';
    // A focusable separator needs a value: panel width in pixels, or the timeline's share of the height in percent.
    const p = prefs();
    const [min, max, now] = which === 'left' ? [240, 720, p.leftW] : which === 'right' ? [260, 640, p.rightW] : [20, 75, Math.round((1 - p.upperH) * 100)];
    const el = h(`div.resizer.${dir}`, { role: 'separator', tabindex: '0', 'aria-label': label, 'aria-orientation': dir === 'v' ? 'vertical' : 'horizontal', 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': now });
    const apply = (delta) => {
      const s = this.el.style;
      if (which === 'left') {
        const w = clamp((parseFloat(s.getPropertyValue('--left-w')) || 440) + delta, 240, 720);
        s.setProperty('--left-w', `${w}px`);
        setPref('leftW', w);
        el.setAttribute('aria-valuenow', String(Math.round(w)));
      } else if (which === 'right') {
        const w = clamp((parseFloat(s.getPropertyValue('--right-w')) || 340) - delta, 260, 640);
        s.setProperty('--right-w', `${w}px`);
        setPref('rightW', w);
        el.setAttribute('aria-valuenow', String(Math.round(w)));
      } else {
        const ws = this.el.querySelector('.workspace').getBoundingClientRect();
        const cur = parseFloat(s.getPropertyValue('--upper')) || 0.56;
        const v = clamp(cur + delta / ws.height, 0.25, 0.8);
        s.setProperty('--upper', String(v));
        setPref('upperH', v);
        el.setAttribute('aria-valuenow', String(Math.round((1 - v) * 100)));
      }
      this.ctx.playerView.relayout?.();
      if (which === 'left') this.ctx.assets.relayout?.();
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      let last = dir === 'v' ? e.clientX : e.clientY;
      const move = (ev) => {
        const cur = dir === 'v' ? ev.clientX : ev.clientY;
        apply(cur - last);
        last = cur;
      };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('keydown', (e) => {
      const k = e.key;
      const stepPx = e.shiftKey ? 48 : 12;
      if ((dir === 'v' && k === 'ArrowLeft') || (dir === 'h' && k === 'ArrowUp')) apply(-stepPx);
      else if ((dir === 'v' && k === 'ArrowRight') || (dir === 'h' && k === 'ArrowDown')) apply(stepPx);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    return el;
  }

  onKey(e) {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (document.querySelector('dialog[open]')) return;
    if (t.closest?.('.menu')) return;
    const typing = t.matches?.('input:not([type=range]):not([type=checkbox]):not([type=color]), textarea, select, [contenteditable="true"]');
    if (typing) {
      // Undo inside text fields belongs to the field, but Escape leaves it.
      if (e.key === 'Escape') t.blur();
      return;
    }
    // Space and Enter activate focused buttons, except where a control opts in to play.
    if ((e.key === ' ' || e.key === 'Enter') && t.matches?.('button, [role=button], [role=tab], [role=radio], [role=switch], a') && !t.closest('[data-space-plays]')) return;
    // Arrow keys belong to sliders, tab lists and the timeline's own navigation.
    if (e.key.startsWith('Arrow') && (t.matches?.('input[type=range], [role=tab], [role=radio], [role=separator], [role=slider]') || t.closest?.('[data-own-arrows]'))) return;
    if (this.ctx.commands.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /**
   * Render the frame at the playhead at full project resolution as a PNG:
   * downloaded, or added to the project's media (toMedia).
   */
  async exportStill({ toMedia = false } = {}) {
    const { store } = this.ctx;
    if (store.duration <= 0) {
      toast('Add something to the timeline first.', { kind: 'info' });
      return;
    }
    try {
      const { renderStill } = await import('../engine/exporter.js');
      const t = Math.min(store.time, Math.max(0, store.duration - 1));
      const bmp = await renderStill(store.project, this.library, t, { maxWidth: store.project.settings.width });
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('Could not encode the image.');
      const stamp = timecode(t, store.fps).replace(/:/g, '-');
      const name = `${store.project.name} ${stamp}.png`.replace(/[\\/:*?"<>|]+/g, ' ');
      if (toMedia) {
        await this.ctx.actions.importFiles([new File([blob], name, { type: 'image/png' })]);
        toast('Frame saved to media.', { kind: 'success' });
        return;
      }
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      announce('Frame exported');
    } catch (err) {
      console.error(err);
      toast(err?.message || 'Could not export this frame.', { kind: 'error' });
    }
  }

  /** Resize the panels to a named arrangement (see LAYOUTS). */
  applyLayout(id) {
    const l = LAYOUTS.find((x) => x.id === id) || LAYOUTS[0];
    const st = this.el.style;
    st.setProperty('--left-w', `${l.leftW}px`);
    st.setProperty('--right-w', `${l.rightW}px`);
    st.setProperty('--upper', String(l.upperH));
    setPref('leftW', l.leftW);
    setPref('rightW', l.rightW);
    setPref('upperH', l.upperH);
    setPref('layout', l.id);
    for (const r of this.el.querySelectorAll('.resizer')) {
      const label = r.getAttribute('aria-label');
      if (label === 'Resize media panel') r.setAttribute('aria-valuenow', String(l.leftW));
      else if (label === 'Resize details panel') r.setAttribute('aria-valuenow', String(l.rightW));
      else r.setAttribute('aria-valuenow', String(Math.round((1 - l.upperH) * 100)));
    }
    this.ctx.playerView.relayout?.();
    this.ctx.assets.relayout?.();
    this.ctx.timeline.render?.(true);
    announce(`${l.label} layout`);
  }

  openShortcuts() {
    openShortcutsDialog(this.ctx.commands);
  }

  openAbout() {
    openDialog({
      title: 'About Video Studio',
      className: 'small',
      body: h('div.about',
        h('div.about-logo', appIcon(64)),
        h('p', 'A multi-track video editor that runs in your browser. Decoding and encoding use your device\'s hardware through WebCodecs, the preview is drawn with WebGL2, and audio math runs in WebAssembly.'),
        h('p', 'Projects and media are saved as files in your Puter cloud.'),
        h('p', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Powered by Puter')),
      ),
    });
  }

  _scheduleCover() {
    clearTimeout(this._coverTimer);
    this._coverTimer = setTimeout(() => this.saveCover(), 4000);
  }

  async saveCover() {
    const { store, player } = this.ctx;
    if (!player?.supported || store.duration <= 0) return;
    try {
      const t = store.project.cover?.time ?? Math.min(store.duration - 1, 1_000_000);
      const keep = player.previewTime;
      player.previewTime = t;
      const blob = await player.snapshot(480);
      player.previewTime = keep;
      player.invalidate();
      if (blob) await this.library.saveCover(store.project.id, blob);
    } catch {
      /* covers are cosmetic */
    }
  }

  /** Keep proxies in step with the project: make wanted ones, stop work for removed media. */
  _watchProxies() {
    const { store } = this;
    const proxies = this.proxies;
    let sig = '';
    const sync = (force = false) => {
      const p = store.project;
      const next = `${proxyMode(p)}|${Object.values(p.assets).map((a) => a.hash).join(',')}`;
      if (!force && next === sig) return;
      sig = next;
      proxies.sync(p);
    };
    proxies.init().then(() => sync(true), () => {});
    this._offProxySync = [
      store.on('change', () => sync()),
      proxies.on('change', (e) => {
        if (e?.slow) sync(true);
      }),
    ];
  }

  async exit(opts = {}) {
    this.ctx.player?.pause();
    await this.saver.flush().catch(() => {});
    await this.saveCover();
    this.dispose();
    if (opts.open) this.onOpenProject?.(opts.open);
    else if (opts.create) this.onNewProject?.();
    else this.onExit?.();
  }

  dispose() {
    this._offPrefs?.();
    this.ctx.history?.dispose?.();
    this.ctx.review?.dispose?.();
    this.ctx.assistant?.dispose?.();
    clearTimeout(this._coverTimer);
    document.removeEventListener('keydown', this._onKey);
    window.removeEventListener('beforeunload', this._onUnload);
    this.saver.dispose();
    this.ctx.mobile?.dispose?.();
    this.ctx.timeline?.dispose?.();
    this.ctx.playerView?.dispose?.();
    this.ctx.inspector?.dispose?.();
    this.ctx.assets?.dispose?.();
    this.ctx.player?.dispose();
    this._offProxySync?.forEach((off) => off());
    this.proxies.dispose();
    this.media.dispose();
    this.library.releaseMedia();
  }
}
