import {it,expect,vi,afterEach} from 'vitest';
import {captionsTab} from '../src/ui/panels/captions.js';
import {EditorStore} from '../src/model/store.js';
import {addTimeline} from '../src/model/timelines.js';
import {createCompound} from '../src/model/compound.js';
import {makeTrack,makeClip} from '../src/model/project.js';
import {setPref} from '../src/ui/prefs.js';
import {fixture,clip,onMain} from './helpers.js';
const tabs=[];
afterEach(()=>{tabs.splice(0).forEach(t=>t.dispose());delete globalThis.puter;document.body.replaceChildren();});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{resolve,promise};};
const words=text=>[{text,start:.1,end:.4}];
const captions=store=>store.project.tracks.flatMap(t=>t.clips).filter(c=>c.caption).map(c=>c.text);
const track=text=>makeTrack('text',{clips:[makeClip('text',{caption:true,text,duration:1000000})]});
const button=(el,text)=>[...el.querySelectorAll('button')].find(b=>b.textContent===text);
function setup(){
 const p=fixture();const [,nested]=onMain(p,clip('audio',0,1),clip('audio',1,1));const compound=createCompound(p,[nested.id]);p.tracks.push(track('Source captions'));const target=addTimeline(p),original=p.timelineId;
 const other=p.timelines.find(t=>t.id===target);other.tracks[0].clips.push(clip('audio',0,1));other.tracks.push(track('Keep these captions'));
 const store=new EditorStore(p),deps={decode:vi.fn(async()=>({sampleRate:16000,channels:[new Float32Array(16000)]})),separate:vi.fn(ch=>ch[0]),transcribe:vi.fn(async()=>words('Default')),beats:vi.fn(()=>null)};
 globalThis.puter={ai:{}};setPref('captionOpts',{});const tab=captionsTab({store,player:null,account:{},library:{backend:{kind:'puter'}},lyricsDeps:deps});tabs.push(tab);document.body.append(tab.el);tab.el.querySelector('[data-cat=lyrics]').click();const create=button(tab.el,'Create lyrics');
 return{store,tab,create,deps,target,original,compound};
}
async function start(env,pending){env.deps.transcribe.mockReturnValueOnce(pending.promise);env.create.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(env.deps.transcribe).toHaveBeenCalledTimes(1));}
it.each(['timeline','compound','dispose'])('keeps late lyrics out of a different context after %s',async kind=>{
 const env=setup(),pending=deferred();await start(env,pending);
 if(kind==='timeline')env.store.openTimeline(env.target);else if(kind==='compound')env.store.openCompound(env.compound.id);else env.tab.dispose();
 const expected=captions(env.store);pending.resolve(words('Wrong lyrics'));await new Promise(r=>setTimeout(r,0));expect(captions(env.store)).toEqual(expected);
});
it.each(['timeline','dispose'])('closes a stale lyrics replacement prompt on %s',async kind=>{
 const env=setup();env.create.click();const dialog=document.querySelector('dialog');if(kind==='timeline')env.store.openTimeline(env.target);else env.tab.dispose();
 expect(dialog.open).toBe(false);await new Promise(r=>setTimeout(r,0));expect(env.deps.decode).not.toHaveBeenCalled();
});
it('opens only one lyrics replacement prompt',()=>{const env=setup();env.create.click();env.create.click();expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);});
it('can restart after cancel and ignores the old job completion',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();await start(env,old);env.deps.transcribe.mockReturnValueOnce(fresh.promise);
 const cancel=button(env.tab.el,'Cancel');cancel.focus();cancel.click();expect(env.create.disabled).toBe(false);expect(document.activeElement).toBe(env.create);
 env.create.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(env.deps.transcribe).toHaveBeenCalledTimes(2));old.resolve(words('Old'));await new Promise(r=>setTimeout(r,0));
 expect(env.create.disabled).toBe(true);expect(env.tab.el.querySelector('.cap-progress').hidden).toBe(false);fresh.resolve(words('Fresh'));await vi.waitFor(()=>expect(captions(env.store)).toEqual(['Fresh']));
});
it('cancels lyrics before starting isolation when decoding finishes in another timeline',async()=>{
 const env=setup(),pending=deferred();env.deps.decode.mockReturnValueOnce(pending.promise);env.create.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(env.deps.decode).toHaveBeenCalledTimes(1));
 env.store.openTimeline(env.target);pending.resolve({sampleRate:16000,channels:[new Float32Array(16000)]});await new Promise(r=>setTimeout(r,0));expect(env.deps.separate).not.toHaveBeenCalled();expect(env.deps.transcribe).not.toHaveBeenCalled();
});
it('does not revive a cancelled job when its timeline is reopened',async()=>{
 const env=setup(),pending=deferred();await start(env,pending);env.store.openTimeline(env.target);env.store.openTimeline(env.original);expect(env.create.disabled).toBe(false);
 pending.resolve(words('Old'));await new Promise(r=>setTimeout(r,0));expect(captions(env.store)).toEqual(['Source captions']);
});
it('keeps normal lyrics undoable without undoing a concurrent rename',async()=>{
 const env=setup(),pending=deferred();await start(env,pending);env.store.update('Rename',p=>{p.name='Renamed';});pending.resolve(words('Fresh'));await vi.waitFor(()=>expect(captions(env.store)).toEqual(['Fresh']));
 env.store.undo();expect(captions(env.store)).toEqual(['Source captions']);expect(env.store.project.name).toBe('Renamed');
});

it('restores focus after dismissing the lyrics replacement prompt',async()=>{
 const env=setup();env.create.focus();env.create.click();button(document.querySelector('dialog'),'Cancel').click();await new Promise(r=>setTimeout(r,0));expect(document.activeElement).toBe(env.create);expect(env.create.disabled).toBe(false);expect(env.deps.decode).not.toHaveBeenCalled();
});

it('does not let stale decoding progress or failure reset a newer lyrics job',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();let oldProgress,newProgress;
 env.deps.decode.mockImplementationOnce((_a,_c,o)=>{oldProgress=o.onProgress;return old.promise;}).mockImplementationOnce((_a,_c,o)=>{newProgress=o.onProgress;return fresh.promise;});
 env.create.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(oldProgress).toBeTypeOf('function'));button(env.tab.el,'Cancel').click();env.create.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(newProgress).toBeTypeOf('function'));
 newProgress(.2);const bar=env.tab.el.querySelector('[role=progressbar]'),before=bar.getAttribute('aria-valuenow');oldProgress(.9);old.resolve(Promise.reject(new Error('Stale decode failed')));await new Promise(r=>setTimeout(r,0));
 expect(env.create.disabled).toBe(true);expect(bar.getAttribute('aria-valuenow')).toBe(before);expect(document.body.textContent).not.toContain('Stale decode failed');env.tab.dispose();fresh.resolve({sampleRate:16000,channels:[new Float32Array(16000)]});
});
it.each(['timeline','dispose'])('terminates an active isolation worker on %s',async kind=>{
 const env=setup(),workers=[];delete env.deps.separate;
 vi.stubGlobal('Worker',class{constructor(){this.ended=false;workers.push(this);}postMessage(){}terminate(){this.ended=true;}});
 try{
  env.create.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(workers).toHaveLength(1));
  if(kind==='timeline')env.store.openTimeline(env.target);else env.tab.dispose();expect(workers[0].ended).toBe(true);await new Promise(r=>setTimeout(r,0));expect(env.deps.transcribe).not.toHaveBeenCalled();
 }finally{env.tab.dispose();vi.unstubAllGlobals();}
});
