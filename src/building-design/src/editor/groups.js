/**
 * Group tools: place an instance of a model group type, and add or remove
 * members while a group is being edited.
 */
import { Tool } from './tool.js';
import { previewGraphics } from './draw.js';
import { placeGroup, groupable } from '../core/groups.js';
import { transformPatch, rotation, translation } from '../core/ops.js';
import { drawTag } from '../views/overlay.js';

export class PlaceGroupTool extends Tool {
  get placingKind() {
    return 'group';
  }

  get title() {
    return 'Place Group';
  }

  get prompt() {
    return this.type ? 'Click to place the group. Space rotates it by 90 degrees.' : 'This project has no model groups yet. Select elements and use Create Group.';
  }

  get type() {
    return this.app.currentType('group');
  }

  start() {
    this.rot = 0;
  }

  down(ev) {
    const type = this.type;
    if (!type) return this.app.toast('Create a group first: select elements and use Create Group.', { kind: 'error' });
    const p = this.snap(ev);
    if (!p) return;
    let g = null;
    this.app.commit('Place group', () => (g = placeGroup(this.doc, type, p, this.rot, this.app.activeLevelId(), this.vc?.view?.id)));
    if (g) this.app.setPrompt(`Placed ${type.name}. Click to place another, Esc to stop.`);
  }

  move(ev) {
    this.cursor = this.snap(ev);
    this.app.requestRender();
  }

  key(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.rot = (this.rot + 90) % 360;
      this.app.requestRender();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    const type = this.type;
    if (type && this.cursor) {
      const r = rotation([0, 0], (this.rot * Math.PI) / 180);
      const t = translation(this.cursor);
      const xf = { point: (q) => t.point(r.point(q)), angle: (this.rot * Math.PI) / 180 };
      const levelId = this.app.activeLevelId();
      for (const m of type.members || []) {
        if (m.hostId) continue;
        const el = { ...m, ...transformPatch(m, xf), id: `preview:${m.localId}`, levelId: m.levelId === '$base' ? levelId : m.levelId };
        previewGraphics(this.app, vc, el, ctx, vp.theme.preview, 0.08);
      }
      const s = vc.modelToScreen(this.cursor);
      drawTag(ctx, s.x + 18, s.y + 22, type.name, { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

/** Click elements to add them to (or remove them from) the group being edited. */
export class GroupMemberTool extends Tool {
  get title() {
    return this.opts.remove ? 'Remove from Group' : 'Add to Group';
  }

  get viewKinds() {
    return null;
  }

  get prompt() {
    return this.opts.remove ? 'Click members to take them out of the group' : 'Click elements to add them to the group';
  }

  target(ev) {
    const ge = this.app.groupEdit;
    if (!ge) return null;
    for (const id of this.vc.hitTest(ev.x, ev.y)) {
      const el = this.doc.get(id);
      if (!groupable(el)) continue;
      if (this.opts.remove ? el.groupId === ge.groupId : !el.groupId) return el;
    }
    return null;
  }

  move(ev) {
    this.app.setHover(this.target(ev)?.id ?? null);
  }

  down(ev) {
    const ge = this.app.groupEdit;
    const el = this.target(ev);
    if (!ge || !el) return;
    const hosted = this.doc.filter((x) => x.hostId === el.id).map((x) => x.id);
    const groupId = this.opts.remove ? null : ge.groupId;
    this.app.commit(this.title, () => [el.id, ...hosted].forEach((id) => this.doc.update(id, { groupId })));
    this.app.flagsVersion++;
    this.app.requestRender();
  }
}
