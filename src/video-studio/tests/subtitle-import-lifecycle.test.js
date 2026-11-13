import {it,expect,vi,afterEach} from 'vitest';
import {captionsTab} from '../src/ui/panels/captions.js';
import {EditorStore} from '../src/model/store.js';
import {createProject,makeTrack,makeClip} from '../src/model/project.js';
import {addTimeline} from '../src/model/timelines.js';
import {createCompound} from '../src/model/compound.js';
import {setPref} from '../src/ui/prefs.js';
const tabs=[];
afterEach(()=>{tabs.splice(0).forEach(t=>t.dispose());document.querySelectorAll('.toast').forEach(t=>t.remove());document.body.replaceChildren();vi.restoreAllMocks();});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const tick=()=>new Promise(r=>setTimeout(r,0));
const srt=text=>new TextEncoder().encode(`1\n00:00:00,000 --> 00:00:01,000\n${text}\n`).buffer;
const texts=store=>store.project.tracks.flatMap(t=>t.clips).filter(c=>c.caption).map(c=>c.text);
const track=(text,locked=false)=>makeTrack('text',{locked,clips:[makeClip('text',{caption:true,text,duration:1000000})]});
const button=(el,text)=>[...el.querySelectorAll('button')].find(b=>b.textContent===text);
function setup({existing=false}={}){
 const p=createProject();const nested=makeClip('text',{text:'Nested',duration:1000000});p.tracks[0].clips.push(nested);const compound=createCompound(p,[nested.id]);if(existing)p.tracks.push(track('Source'),track('Locked',true));
 const target=addTimeline(p),original=p.timelineId;const store=new EditorStore(p);setPref('captionOpts',{});
 const tab=captionsTab({store,library:{backend:{kind:'opfs'}},player:null,account:{}});tabs.push(tab);document.body.append(tab.el);tab.el.querySelector('[data-cat=files]').click();
 const input=tab.el.querySelector('input[type=file]'),importBtn=button(tab.el,'Import .srt or .vtt');vi.spyOn(input,'click').mockImplementation(()=>{});
 return{store,tab,input,importBtn,target,original,compound};
}
function select(env,read){const file={name:'captions.srt',arrayBuffer:vi.fn(()=>read)};Object.defineProperty(env.input,'files',{configurable:true,value:[file]});env.input.dispatchEvent(new Event('change'));return file;}
function start(env,read){env.importBtn.focus();env.importBtn.click();return select(env,read);}
it.each(['timeline','compound','dispose','return'])('ignores a late file after %s',async kind=>{
 const env=setup(),pending=deferred();start(env,pending.promise);
 if(kind==='timeline'||kind==='return'){env.store.openTimeline(env.target);if(kind==='return')env.store.openTimeline(env.original);}else if(kind==='compound')env.store.openCompound(env.compound.id);else env.tab.dispose();
 const expected=texts(env.store);pending.resolve(srt('Wrong'));await tick();expect(texts(env.store)).toEqual(expected);
});
it.each(['timeline','dispose'])('closes an import replacement prompt on %s',async kind=>{
 const env=setup({existing:true});start(env,Promise.resolve(srt('Wrong')));await tick();const dialog=document.querySelector('dialog');expect(dialog.open).toBe(true);
 if(kind==='timeline')env.store.openTimeline(env.target);else env.tab.dispose();expect(dialog.open).toBe(false);await tick();expect(texts(env.store)).toEqual(kind==='timeline'?[]:['Source','Locked']);
});
it('does not start a late file selection after the picker context changes',async()=>{
 const env=setup();env.importBtn.click();env.store.openTimeline(env.target);const file=select(env,Promise.resolve(srt('Wrong')));await tick();expect(file.arrayBuffer).not.toHaveBeenCalled();expect(texts(env.store)).toEqual([]);
});
it('ignores an unreadable old file after the context changes',async()=>{
 const env=setup(),pending=deferred();start(env,pending.promise);env.store.openTimeline(env.target);pending.reject(Error('Read failed'));await tick();expect(document.body.textContent).not.toContain('No captions were found');
});
it('allows cancellation and immediate restart without an old read resetting the new one',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();start(env,old.promise);const cancel=button(env.tab.el,'Cancel import');expect(cancel).toBeTruthy();cancel.focus();cancel.click();expect(env.importBtn.disabled).toBe(false);expect(document.activeElement).toBe(env.importBtn);
 start(env,fresh.promise);old.resolve(srt('Old'));await tick();expect(env.importBtn.disabled).toBe(true);expect(texts(env.store)).toEqual([]);fresh.resolve(srt('Fresh'));await tick();expect(texts(env.store)).toEqual(['Fresh']);expect(env.importBtn.disabled).toBe(false);
});
it('does not open duplicate prompts or reread a file while awaiting a choice',async()=>{
 const env=setup({existing:true});const file=start(env,Promise.resolve(srt('Fresh')));await tick();env.importBtn.click();env.input.dispatchEvent(new Event('change'));await tick();expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
});
it('can choose again after dismissing the native picker',async()=>{
 const env=setup();env.importBtn.click();env.input.dispatchEvent(new Event('cancel'));start(env,Promise.resolve(srt('Fresh')));await tick();expect(texts(env.store)).toEqual(['Fresh']);
});
it('restores import-button focus after dismissing the replacement prompt',async()=>{
 const env=setup({existing:true});start(env,Promise.resolve(srt('Fresh')));await tick();button(document.querySelector('dialog'),'Cancel').click();await tick();expect(document.activeElement).toBe(env.importBtn);expect(env.importBtn.disabled).toBe(false);expect(texts(env.store)).toEqual(['Source','Locked']);
});
it.each(['Replace','Keep both'])('preserves normal %s, locked captions and concurrent edits through undo',async mode=>{
 const env=setup({existing:true}),pending=deferred();const file=start(env,pending.promise);env.store.update('Rename',p=>{p.name='Renamed';});pending.resolve(srt('Fresh'));await tick();button(document.querySelector('dialog'),mode).click();await tick();expect(texts(env.store)).toEqual(mode==='Replace'?['Fresh','Locked']:['Fresh','Source','Locked']);expect(file.arrayBuffer).toHaveBeenCalledTimes(1);env.store.undo();expect(texts(env.store)).toEqual(['Source','Locked']);expect(env.store.project.name).toBe('Renamed');
});
it.each(['empty','error'])('recovers from an %s file and accepts another import',async kind=>{
 const env=setup();start(env,kind==='empty'?Promise.resolve(new ArrayBuffer(0)):Promise.reject(Error('Unreadable')));await tick();expect(document.body.textContent).toContain('No captions were found');expect(env.importBtn.disabled).toBe(false);start(env,Promise.resolve(srt('Fresh')));await tick();expect(texts(env.store)).toEqual(['Fresh']);
});
it('cancels when the files category is hidden and does not revive after returning',async()=>{
 const env=setup(),pending=deferred();start(env,pending.promise);env.tab.el.querySelector('[data-cat=list]').click();env.store.openTimeline(env.target);pending.resolve(srt('Wrong'));await tick();expect(texts(env.store)).toEqual([]);
});
it('does not let a stale read error affect a fresh import',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();start(env,old.promise);env.store.openTimeline(env.target);start(env,fresh.promise);old.reject(Error('Old read failed'));await tick();expect(env.importBtn.disabled).toBe(true);expect(document.body.textContent).not.toContain('No captions were found');fresh.resolve(srt('Fresh'));await tick();expect(texts(env.store)).toEqual(['Fresh']);
});
it('releases its change observer after success, cancellation and picker dismissal',async()=>{
 const env=setup(),on=env.store.on.bind(env.store),offs=[];
 vi.spyOn(env.store,'on').mockImplementation((type,fn)=>{const off=vi.fn(on(type,fn));offs.push(off);return off;});
 start(env,Promise.resolve(srt('Fresh')));await tick();expect(offs).toHaveLength(1);expect(offs[0]).toHaveBeenCalledTimes(1);
 const pending=deferred();start(env,pending.promise);button(env.tab.el,'Cancel import').click();expect(offs[1]).toHaveBeenCalledTimes(1);pending.resolve(srt('Old'));await tick();
 env.importBtn.click();env.input.dispatchEvent(new Event('cancel'));expect(offs[2]).toHaveBeenCalledTimes(1);env.tab.dispose();expect(offs.every(off=>off.mock.calls.length===1)).toBe(true);
});
