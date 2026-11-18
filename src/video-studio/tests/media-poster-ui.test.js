import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mediaTab } from '../src/ui/panels/media.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { Emitter } from '../src/lib/emitter.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture } from './helpers.js';

let tab, contexts;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const bitmap = () => ({ width: 320, height: 180 });
beforeEach(() => {
  document.body.replaceChildren(); contexts = new WeakMap();
  setPref('assetCats', {});setPref('mediaView', 'grid');setPref('mediaTypes', []);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    if (!contexts.has(this)) contexts.set(this, { fillRect: vi.fn(), drawImage: vi.fn() });
    return contexts.get(this);
  });
});
afterEach(() => { tab?.dispose();tab=null;vi.restoreAllMocks();setPref('mediaView','grid'); });
function mount(poster = async () => null) {
  const p=fixture(), image=p.assets.img;
  p.assets={a:{...image,id:'a',name:'A',hash:'same'},b:{...image,id:'b',name:'B',hash:'same'},other:{...image,id:'other',name:'Other',hash:'different'}};
  const store=new EditorStore(p), media=Object.assign(new Emitter(), {poster:vi.fn(poster),missing:new Set()});
  const ctx={store,media,library:{backend:{kind:'memory'}}};ctx.actions=createActions(ctx);
  tab=mediaTab(ctx);document.body.append(tab.el);return media;
}
const canvas = id => tab.el.querySelector(`[data-asset="${id}"] canvas`);

it.each(['grid','list'])('repaints only matching %s posters in place after recovery', async view => {
  setPref('mediaView',view);const media=mount();await flush();
  const a=canvas('a'),b=canvas('b'),other=canvas('other');
  const button=a.closest('button');button.click();button.focus();
  const content=tab.el.querySelector('.asset-content');content.scrollTop=37;
  const fresh=bitmap();media.poster.mockImplementation(async asset=>asset.hash==='same'?fresh:null);
  media.emit('poster',{hash:'same'});await flush();
  expect(contexts.get(a).drawImage).toHaveBeenCalledWith(fresh,0,0,a.width,a.height);
  expect(contexts.get(b).drawImage).toHaveBeenCalledTimes(1);
  expect(contexts.get(other).drawImage).not.toHaveBeenCalled();
  expect(canvas('a')).toBe(a);expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-pressed')).toBe('true');expect(content.scrollTop).toBe(37);
  media.emit('poster',{hash:'same'});await flush();
  expect(contexts.get(a).drawImage).toHaveBeenCalledTimes(1);
});

it('ignores an initial empty answer that arrives after a recovered poster', async () => {
  let finish;const old=new Promise(resolve=>{finish=resolve;});
  const media=mount(asset=>asset.id==='a'?old:Promise.resolve(null));await flush();
  const a=canvas('a'),fresh=bitmap();media.poster.mockResolvedValue(fresh);
  media.emit('poster',{hash:'same'});await flush();
  expect(contexts.get(a).drawImage).toHaveBeenCalledTimes(1);
  const fills=contexts.get(a).fillRect.mock.calls.length;
  finish(null);await flush();
  expect(contexts.get(a).fillRect).toHaveBeenCalledTimes(fills);
  expect(contexts.get(a).drawImage.mock.calls[0][0]).toBe(fresh);
});

it('drops hidden canvases and ignores their late poster results', async () => {
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const media=mount(()=>pending);
  const a=canvas('a');tab.el.querySelector('[data-cat=audio]').click();
  expect(tab.el.querySelector('.tile-canvas')).toBeNull();
  media.poster.mockClear();media.emit('poster',{hash:'same'});
  finish(bitmap());await flush();
  expect(contexts.get(a).drawImage).not.toHaveBeenCalled();
  expect(media.poster).not.toHaveBeenCalled();
});

it('unsubscribes and ignores pending poster answers after disposal', async () => {
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const media=mount(()=>pending);
  const a=canvas('a');tab.dispose();media.poster.mockClear();
  media.emit('poster',{hash:'same'});finish(bitmap());await flush();
  expect(contexts.get(a).drawImage).not.toHaveBeenCalled();
  expect(media.poster).not.toHaveBeenCalled();
});
