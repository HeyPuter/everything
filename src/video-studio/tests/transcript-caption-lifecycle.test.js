import {it,expect,vi,afterEach} from 'vitest';
import {captionsTab} from '../src/ui/panels/captions.js';
import {EditorStore} from '../src/model/store.js';
import {createProject,makeTrack,makeClip} from '../src/model/project.js';
import {addTimeline} from '../src/model/timelines.js';
import {createCompound} from '../src/model/compound.js';
import {setPref} from '../src/ui/prefs.js';
import {closeMenus} from '../src/ui/menu.js';
const tabs=[];
afterEach(()=>{closeMenus();tabs.splice(0).forEach(t=>t.dispose());document.querySelectorAll('dialog').forEach(d=>d.dispatchEvent(new Event('cancel',{cancelable:true})));document.querySelectorAll('.toast').forEach(t=>t.remove());document.body.replaceChildren();vi.restoreAllMocks();});
const tick=()=>new Promise(r=>setTimeout(r,0));
const track=(text,locked=false)=>makeTrack('text',{locked,clips:[makeClip('text',{caption:true,text,duration:1000000})]});
const texts=store=>store.project.tracks.flatMap(t=>t.clips).filter(c=>c.caption).map(c=>c.text);
const button=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
function setup({existing=true}={}){
 const p=createProject();p.transcript={words:[{text:'Fresh',start:100000,end:400000},{text:'words',start:500000,end:900000}]};
 const nested=makeClip('text',{text:'Nested',duration:1000000});p.tracks[0].clips.push(nested);const compound=createCompound(p,[nested.id]);if(existing)p.tracks.push(track('Source'),track('Locked',true));
 const target=addTimeline(p),original=p.timelineId;p.timelines.find(t=>t.id===target).tracks.push(track('Destination'));
 const store=new EditorStore(p);setPref('captionOpts',{captionStyle:'pop-sweep'});const tab=captionsTab({store,library:{backend:{kind:'opfs'}},account:{},player:null});tabs.push(tab);document.body.append(tab.el);tab.el.querySelector('[data-cat=transcript]').click();
 const more=tab.el.querySelector('[aria-label="More transcript options"]');
 return{store,tab,target,original,compound,more};
}
function start(env){env.more.focus();env.more.click();const item=button(document.querySelector('[role=menu]'),'Make captions from transcript');item.click();return item;}
it.each(['timeline','compound','project','dispose','return'])('closes and invalidates transcript-caption confirmation after %s',async kind=>{
 const env=setup();start(env);const dialog=document.querySelector('dialog');
 if(kind==='timeline'||kind==='return'){env.store.openTimeline(env.target);if(kind==='return')env.store.openTimeline(env.original);}else if(kind==='compound')env.store.openCompound(env.compound.id);else if(kind==='project')env.store.load(createProject());else env.tab.dispose();
 const expected=texts(env.store);button(dialog,'Replace').click();await tick();expect(texts(env.store)).toEqual(expected);expect(dialog.open).toBe(false);
});
it.each(['timeline','dispose'])('does not apply no-prompt captions after %s',async kind=>{
 const env=setup({existing:false});start(env);if(kind==='timeline')env.store.openTimeline(env.target);else env.tab.dispose();const expected=texts(env.store);await tick();expect(texts(env.store)).toEqual(expected);
});
it('opens only one replacement prompt for repeated transcript-caption actions',()=>{
 const env=setup(),item=start(env);item.click();expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
});
it('does not reopen a caption prompt from a retained menu item after disposal',()=>{
 const env=setup();env.more.click();const item=button(document.querySelector('[role=menu]'),'Make captions from transcript');env.tab.dispose();item.click();expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
});
it('keeps a newer prompt alive while an obsolete prompt settles',async()=>{
 const env=setup();start(env);env.store.openTimeline(env.target);env.store.openTimeline(env.original);start(env);const fresh=document.querySelector('dialog[open]');await tick();expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);expect(fresh.open).toBe(true);button(fresh,'Replace').click();await tick();expect(texts(env.store)).toEqual(['Fresh words','Locked']);
});
it.each(['Cancel','Escape'])('preserves captions and restores focus on %s, then allows retry',async action=>{
 const env=setup();start(env);const dialog=document.querySelector('dialog');if(action==='Cancel')button(dialog,'Cancel').click();else dialog.dispatchEvent(new Event('cancel',{cancelable:true}));await tick();expect(texts(env.store)).toEqual(['Source','Locked']);expect(document.activeElement).toBe(env.more);start(env);button(document.querySelector('dialog'),'Replace').click();await tick();expect(texts(env.store)).toEqual(['Fresh words','Locked']);
});
it.each(['Replace','Keep both'])('preserves normal %s, style, timing, locked captions and concurrent edits through undo',async mode=>{
 const env=setup();start(env);env.store.update('Rename',p=>{p.name='Renamed';});button(document.querySelector('dialog'),mode).click();await tick();expect(texts(env.store)).toEqual(mode==='Replace'?['Fresh words','Locked']:['Fresh words','Source','Locked']);const c=env.store.project.tracks.flatMap(t=>t.clips).find(c=>c.text==='Fresh words');expect(c).toMatchObject({start:100000,duration:800000,captionStyle:'pop-sweep',animLoop:{id:'karaoke'}});env.store.undo();expect(texts(env.store)).toEqual(['Source','Locked']);expect(env.store.project.name).toBe('Renamed');
});
it('creates captions immediately without a replacement prompt when none exist',async()=>{
 const env=setup({existing:false});start(env);expect(texts(env.store)).toEqual(['Fresh words']);await tick();expect(texts(env.store)).toEqual(['Fresh words']);expect(document.querySelector('dialog')).toBeNull();env.store.undo();expect(texts(env.store)).toEqual([]);
});
it('removes its context observer after dismissal, application and disposal',async()=>{
 const env=setup(),on=env.store.on.bind(env.store),offs=[];vi.spyOn(env.store,'on').mockImplementation((type,fn)=>{const off=vi.fn(on(type,fn));offs.push(off);return off;});
 start(env);button(document.querySelector('dialog'),'Cancel').click();await tick();start(env);button(document.querySelector('dialog'),'Keep both').click();await tick();start(env);env.tab.dispose();await tick();expect(offs).toHaveLength(3);expect(offs.every(off=>off.mock.calls.length===1)).toBe(true);
});
