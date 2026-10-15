// Timeline editor: a compact Dope Sheet that shows the summary keyframes of the selected
// objects with playback controls, frame range, markers and the preview range in its header.
// Keys can be selected and edited with the Dope Sheet tools; the frame ruler scrubs.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { registerEditor, type Area } from '../ui/screen';
import type { MenuItem } from '../ui/menu';
import { DopeSheet } from '../animation/dopesheet';
import { RULER_H, menuButton } from '../animation/animeditor';
import { markerMenu } from '../animation/markers';
import { previewRangeMenu } from '../animation/menus';
import { playbackFooter } from '../animation/footer';
import { aggregate } from '../animation/aggregate';
import { drawKey } from '../animation/theme';

/** Cached frames drawn as strips along the bottom of the timeline (e.g. simulation caches). */
export const timelineCacheProviders: (() => { frames: number[]; baked: boolean; color: string }[])[] = [];
/** Extra drawing in the timeline's content area (e.g. physics cache bars) and its View menu entries. */
export const timelineOverlays: ((g: CanvasRenderingContext2D, tl: Timeline, W: number) => void)[] = [];
export const timelineViewMenuHooks: ((tl: Timeline) => MenuItem[])[] = [];

export class Timeline extends DopeSheet {
  /** keys shown only for selected channels' objects (the summary of selected objects) */
  constructor(area: Area, state?: unknown) {
    super(area, state);
    this.el.classList.add('timeline-ed');
    this.compactMarkers = true;
    const s = (state ?? {}) as Record<string, unknown>;
    if (typeof s.onlySelected !== 'boolean') this.onlySelected = true;
  }

  header(): Child {
    return h('div', { class: 'hdr-row' }, menuButton('View', () => this.viewMenu()), menuButton('Marker', markerMenu), playbackFooter(this.snapHeader()));
  }

  protected footer(): Child | null {
    return null;
  }

  protected sidebarTabs() {
    return [];
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Show Markers', checked: this.showMarkers, action: () => ((this.showMarkers = !this.showMarkers), this.refresh()) },
      { label: 'Only Show Selected', checked: this.onlySelected, action: () => ((this.onlySelected = !this.onlySelected), this.refresh(), app.changed('ui')) },
      { label: 'Show Hidden', checked: this.showHidden, action: () => ((this.showHidden = !this.showHidden), this.refresh(), app.changed('ui')) },
      { label: 'Show Seconds', checked: this.showSeconds, op: 'anim.show_seconds_toggle', shortcut: 'Ctrl T' },
      ...timelineViewMenuHooks.flatMap((f) => f(this)),
      { separator: true },
      { label: 'Frame All', op: 'action.view_all', shortcut: 'Home' },
      { label: 'Frame Scene Range', op: 'anim.scene_range_frame' },
      { label: 'Go to Current Frame', op: 'action.view_frame', shortcut: 'Numpad 0' },
      { separator: true },
      ...previewRangeMenu('action.previewrange_set'),
      { separator: true },
      {
        label: this.area.screen.maximized === this.area ? 'Back to Previous' : 'Maximize Area',
        op: 'screen.screen_full_area',
        shortcut: 'Ctrl Space',
      },
    ];
  }

  layout() {
    super.layout();
    // channels stay hidden: the timeline shows a single summary row
    this.chEl.style.display = 'none';
  }

  rebuild() {
    super.rebuild();
    const sum = this.list.rows.find((r) => r.kind === 'SUMMARY');
    this.list = { rows: sum ? [{ ...sum, label: 'Summary' }] : [], curves: this.list.curves };
    // the summary row fills the space between the ruler and the markers
    const avail = this.contentBottom() - RULER_H;
    this.rowH = Math.max(12, Math.min(28, avail || 18));
  }

  protected drawContent(g: CanvasRenderingContext2D, W: number) {
    this.drawCaches(g, W);
    for (const o of timelineOverlays) o(g, this, W);
    const ch = this.list.rows[0];
    if (!ch?.curves.length) return;
    const agg = aggregate(ch.curves.map((r) => r.fc));
    const yc = this.rowTop(0) + this.rowH / 2;
    const size = Math.max(8, Math.min(12, Math.round(this.rowH * 0.62)));
    for (const k of agg.keys) {
      const x = this.view.fx(k.frame);
      if (x < -10 || x > W + 10) continue;
      drawKey(g, Math.round(x) + 0.5, Math.round(yc) + 0.5, size, k.type, k.selected, 'DIAMOND', 1);
    }
  }

  /** Runs of cached frames as thin strips (brighter when baked). */
  private drawCaches(g: CanvasRenderingContext2D, W: number) {
    const caches = timelineCacheProviders.flatMap((p) => p());
    let y = this.contentBottom() - 4;
    for (const c of caches) {
      if (!c.frames.length) continue;
      g.fillStyle = c.color;
      g.globalAlpha = c.baked ? 0.9 : 0.5;
      let a = c.frames[0];
      for (let i = 1; i <= c.frames.length; i++) {
        const f = c.frames[i];
        if (f === c.frames[i - 1] + 1) continue;
        const x0 = Math.max(0, this.view.fx(a - 0.5)),
          x1 = Math.min(W, this.view.fx(c.frames[i - 1] + 0.5));
        if (x1 > x0) g.fillRect(x0, y, x1 - x0, 3);
        a = f;
      }
      g.globalAlpha = 1;
      y -= 4;
    }
  }
}

registerEditor({ id: 'TIMELINE', label: 'Timeline', icon: 'time_editor', group: 'Animation', create: (a, s) => new Timeline(a, s) });
