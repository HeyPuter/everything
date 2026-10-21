/**
 * Placing spaces: like rooms, a click inside an area enclosed by walls or
 * separation lines. Spaces can also be placed in every enclosed area, or
 * one per room with the room's name and number.
 */
import { Tool } from './tool.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fillModel, strokeModel, drawTag } from '../views/overlay.js';
import { SPACE_TYPES } from '../core/spaces.js';
import { MM_PER_FOOT } from '../core/units.js';

function nextSpaceNumber(doc, levelId) {
  const lv = doc.get(levelId);
  const base = (Math.max(0, doc.levels().indexOf(lv)) + 1) * 100;
  const used = new Set(doc.all('space').map((s) => String(s.number)));
  let n = base + 1;
  while (used.has(String(n))) n++;
  return String(n);
}

function spaceHeight(doc) {
  return doc.units.system === 'imperial' ? 8 * MM_PER_FOOT : 2700;
}

export class SpaceTool extends Tool {
  get title() {
    return 'Place Space';
  }

  get viewKinds() {
    return ['plan', 'ceilingPlan'];
  }

  get prompt() {
    return this.region ? 'Click to place a space here' : 'Move into an area enclosed by walls or separation lines';
  }

  move(ev) {
    this.at = ev.p;
    this.region = ev.p ? this.app.scene.rooms.regionAt(this.app.activeLevelId(), ev.p) : null;
    this.app.setPrompt(this.prompt);
    this.app.requestRender();
  }

  down(ev) {
    if (!ev.p) return;
    const doc = this.doc;
    const levelId = this.app.activeLevelId();
    const region = this.app.scene.rooms.regionAt(levelId, ev.p);
    if (region) {
      const existing = doc.all('space').find((s) => s.levelId === levelId && this.app.scene.rooms.room(s)?.outer === region.outer);
      if (existing) return this.app.toast(`This area already has a space (${existing.name}).`, { kind: 'error' });
    }
    const o = this.app.toolOptions('space', { spaceType: 'office' });
    // Take the name and number of the room it shares an area with.
    const room = region && doc.all('room').find((r) => r.levelId === levelId && this.app.scene.rooms.room(r)?.outer === region.outer);
    this.app.commit('Space', () => doc.add({ kind: 'space', levelId, at: ev.p, name: room?.name || 'Space', number: room?.number || nextSpaceNumber(doc, levelId), spaceType: o.spaceType, height: spaceHeight(doc), zoneId: o.zoneId || null }));
  }

  options() {
    const o = this.app.toolOptions('space', { spaceType: 'office' });
    const type = h('select.input.sm', { 'aria-label': 'Space type' }, SPACE_TYPES.map((t) => h('option', { value: t.value }, t.label)));
    type.value = o.spaceType;
    type.addEventListener('change', () => (o.spaceType = type.value));
    const zone = h('select.input.sm', { 'aria-label': 'Zone' }, h('option', { value: '' }, 'None'), this.doc.all('zone').map((z) => h('option', { value: z.id }, z.name)));
    zone.value = o.zoneId || '';
    zone.addEventListener('change', () => (o.zoneId = zone.value || null));
    return [h('div.ob-group', h('label', 'Type'), type), h('div.ob-group', h('label', 'Zone'), zone), h('button.btn.sm', { type: 'button', onClick: () => placeSpacesAutomatically(this.app) }, icon('space', 14), 'Place spaces automatically')];
  }

  drawOverlay(ctx, vc, vp) {
    if (!this.region) return;
    const S = (p) => vc.modelToScreen(p);
    fillModel(ctx, this.region.outer, S, vp.theme.preview, 0.12);
    strokeModel(ctx, this.region.outer, S, vp.theme.preview, 1.5, [6, 4], true);
    const s = S(this.at);
    drawTag(ctx, s.x, s.y - 24, this.app.formatArea(this.region.area), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
  }
}

/** A space for every room of the active level that has none, named after it. */
export function placeSpacesAutomatically(app) {
  const doc = app.doc;
  const levelId = app.activeLevelId();
  const rooms = app.scene.rooms;
  const taken = new Set(doc.all('space').filter((s) => s.levelId === levelId).map((s) => rooms.room(s)?.outer).filter(Boolean));
  const o = app.toolOptions('space', { spaceType: 'office' });
  let n = 0;
  app.commit('Place spaces', () => {
    for (const r of doc.all('room')) {
      if (r.levelId !== levelId) continue;
      const reg = rooms.room(r);
      if (!reg || taken.has(reg.outer)) continue;
      taken.add(reg.outer);
      doc.add({ kind: 'space', levelId, at: r.at, name: r.name, number: r.number || nextSpaceNumber(doc, levelId), spaceType: o.spaceType, height: +r.upperOffset || spaceHeight(doc), zoneId: o.zoneId || null });
      n++;
    }
  });
  app.toast(n ? `Placed ${n} space${n === 1 ? '' : 's'}, one per room.` : 'Every room on this level already has a space. Place rooms first, or click areas with the Space tool.');
}
