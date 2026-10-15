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
    return h('div', { class: 'hdr-row' }, menuButton('View', () => this.viewMenu()), menuButton('Marker', markerMenu), playbackFooter());
  }

  protected footer(): Child | null {
    return null;
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Show Markers', checked: this.showMarkers, action: () => ((this.showMarkers = !this.showMarkers), this.refresh()) },
      { label: 'Only Show Selected', checked: this.onlySelected, action: () => ((this.onlySelected = !this.onlySelected), this.refresh(), app.changed('ui')) },
      { label: 'Show Hidden', checked: this.showHidden, action: () => ((this.showHidden = !this.showHidden), this.refresh(), app.changed('ui')) },
      { label: 'Show Seconds', checked: this.showSeconds, op: 'anim.show_seconds_toggle', shortcut: 'Ctrl T' },
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
}

registerEditor({ id: 'TIMELINE', label: 'Timeline', icon: 'time_editor', group: 'Animation', create: (a, s) => new Timeline(a, s) });
