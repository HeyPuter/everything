import {it,expect,vi,afterEach} from 'vitest';
import {captionsTab} from '../src/ui/panels/captions.js';
import {EditorStore} from '../src/model/store.js';
import {createProject,makeTrack,makeClip,normalizeAsset} from '../src/model/project.js';
import {addTimeline} from '../src/model/timelines.js';
import {createCompound} from '../src/model/compound.js';
import {createActions} from '../src/ui/actions.js';
const tabs=[];let serial=0;
afterEach(()=>{tabs.splice(0).forEach(t=>t.dispose());delete globalThis.puter;document.querySelectorAll('.toast').forEach(t=>t.remove());document.body.replaceChildren();vi.restoreAllMocks();});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const tick=()=>new Promise(r=>setTimeout(r,0));
const audio=store=>store.project.tracks.flatMap(t=>t.clips).filter(c=>c.type==='audio');
const asset=()=>normalizeAsset({id:'speech',name:'Speech.wav',kind:'audio',mime:'audio/wav',ext:'wav',duration:1000000,hasAudio:true});
function setup(){
 const p=createProject(),n=++serial,caption=makeClip('text',{caption:true,text:'Speech source '+n,start:300000,duration:2000000}),other=makeClip('text',{caption:true,text:'Other source '+n,start:3000000,duration:1000000});p.tracks.push(makeTrack('text',{clips:[caption,other]}));const nested=makeClip('text',{text:'Nested',duration:1000000});p.tracks[0].clips.push(nested);const compound=createCompound(p,[nested.id]),target=addTimeline(p),original=p.timelineId,dest=makeClip('text',{caption:true,text:'Destination '+n,duration:1000000});p.timelines.find(t=>t.id===target).tracks.push(makeTrack('text',{clips:[dest]}));
 const store=new EditorStore(p),provider=vi.fn(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,blob:async()=>new Blob(['speech'],{type:'audio/wav'})}),library={backend:{kind:'puter'},importFile:vi.fn(async()=>asset())};globalThis.puter={ai:{txt2speech:provider}};const ctx={store,library,player:null,account:{}};ctx.actions=createActions(ctx);const tab=captionsTab(ctx);tabs.push(tab);document.body.append(tab.el);tab.el.querySelector('[data-cat=list]').click();store.select(caption.id);const read=[...tab.el.querySelectorAll('button')].find(b=>b.textContent==='Text to speech');return{ctx,store,tab,read,provider,fetch,library,caption,other,target,original,compound,dest};
}
function start(env,pending){env.provider.mockReturnValueOnce(pending.promise);env.read.click();}
function change(env,kind){if(kind==='timeline'||kind==='return'){env.store.openTimeline(env.target);if(kind==='return')env.store.openTimeline(env.original);}else if(kind==='compound')env.store.openCompound(env.compound.id);else if(kind==='project')env.store.load(createProject());else env.tab.dispose();}
it.each(['timeline','compound','project','dispose','return'])('does not download or import late speech after %s',async kind=>{
 const env=setup(),pending=deferred();start(env,pending);change(env,kind);pending.resolve({src:'https://speech.invalid/audio'});await tick();expect(env.fetch).not.toHaveBeenCalled();expect(env.library.importFile).not.toHaveBeenCalled();expect(audio(env.store)).toHaveLength(0);
});
it.each(['timeline','project','dispose','return'])('does not register or insert speech when an import finishes after %s',async kind=>{
 const env=setup(),pending=deferred();env.provider.mockResolvedValue({src:'https://speech.invalid/audio'});env.library.importFile.mockReturnValueOnce(pending.promise);env.read.click();await vi.waitFor(()=>expect(env.library.importFile).toHaveBeenCalledTimes(1));change(env,kind);pending.resolve(asset());await tick();expect(audio(env.store)).toHaveLength(0);expect(env.store.project.assets.speech).toBeUndefined();expect(env.ctx.imports.size).toBe(0);
});
it('aborts a download and prevents import if its body arrives late',async()=>{
 const env=setup(),pending=deferred();env.provider.mockResolvedValue({src:'https://speech.invalid/audio'});env.fetch.mockResolvedValue({ok:true,blob:()=>pending.promise});env.read.click();await vi.waitFor(()=>expect(env.fetch).toHaveBeenCalledTimes(1));env.store.openTimeline(env.target);const signal=env.fetch.mock.calls[0][1]?.signal;pending.resolve(new Blob(['late'],{type:'audio/wav'}));await tick();expect(signal?.aborted).toBe(true);expect(env.library.importFile).not.toHaveBeenCalled();
});
it('does not enable or duplicate speech when selection changes during synthesis',()=>{
 const env=setup(),pending=deferred();start(env,pending);env.store.select(env.other.id);env.read.click();expect(env.read.disabled).toBe(true);expect(env.provider).toHaveBeenCalledTimes(1);
});
it('keeps a fresh speech job busy when an obsolete provider reply settles',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();start(env,old);env.store.openTimeline(env.target);env.store.select(env.dest.id);start(env,fresh);old.resolve({src:'https://speech.invalid/old'});await tick();expect(env.read.disabled).toBe(true);expect(env.fetch).not.toHaveBeenCalled();fresh.resolve({src:'https://speech.invalid/fresh'});await tick();expect(audio(env.store)).toHaveLength(1);expect(audio(env.store)[0].start).toBe(0);
});
it('suppresses stale provider errors after context cancellation',async()=>{
 const env=setup(),pending=deferred();start(env,pending);env.store.openTimeline(env.target);pending.reject(Error('Old synthesis failed'));await tick();expect(document.body.textContent).not.toContain('Old synthesis failed');
});
it('retains captured text/start and normal import, selection and undo',async()=>{
 const env=setup(),pending=deferred();start(env,pending);env.store.update('Rename',p=>{p.name='Renamed';});env.store.select(env.other.id);pending.resolve({src:'https://speech.invalid/audio'});await tick();expect(audio(env.store)).toHaveLength(1);expect(audio(env.store)[0].start).toBe(300000);expect(env.library.importFile.mock.calls[0][0].name).toContain('Speech source');expect(env.provider).toHaveBeenCalledTimes(1);expect(env.fetch).toHaveBeenCalledTimes(1);expect(env.store.selected.clip.type).toBe('audio');expect(env.read.disabled).toBe(true);env.store.undo();expect(audio(env.store)).toHaveLength(0);expect(env.store.project.name).toBe('Renamed');
});
it('restores eligibility after a real failure and can retry',async()=>{
 const env=setup(),pending=deferred();start(env,pending);pending.reject(Error('Synthesis failed'));await tick();expect(document.body.textContent).toContain('Synthesis failed');expect(env.read.disabled).toBe(false);env.provider.mockResolvedValue({src:'https://speech.invalid/retry'});env.read.click();await tick();expect(audio(env.store)).toHaveLength(1);
});
it('keeps a newer synthesis busy when an obsolete import finishes',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();env.provider.mockResolvedValueOnce({src:'https://speech.invalid/old'}).mockReturnValueOnce(fresh.promise);env.library.importFile.mockReturnValueOnce(old.promise);env.read.click();await vi.waitFor(()=>expect(env.library.importFile).toHaveBeenCalledTimes(1));env.store.openTimeline(env.target);env.store.select(env.dest.id);env.read.click();old.resolve(asset());await tick();expect(env.read.disabled).toBe(true);expect(audio(env.store)).toHaveLength(0);expect(env.store.project.assets.speech).toBeUndefined();fresh.resolve({src:'https://speech.invalid/fresh'});await tick();expect(audio(env.store)).toHaveLength(1);
});
it('removes context observers after normal completion and cancellation',async()=>{
 const env=setup(),on=env.store.on.bind(env.store),offs=[];vi.spyOn(env.store,'on').mockImplementation((type,fn)=>{const off=vi.fn(on(type,fn));offs.push(off);return off;});env.provider.mockResolvedValueOnce({src:'https://speech.invalid/voice'});env.read.click();await tick();expect(offs).toHaveLength(2);expect(offs.every(off=>off.mock.calls.length===1)).toBe(true);env.store.select(env.other.id);const pending=deferred();start(env,pending);env.store.openTimeline(env.target);expect(offs).toHaveLength(3);expect(offs[2]).toHaveBeenCalledTimes(1);pending.resolve({src:'https://speech.invalid/old'});await tick();expect(offs[2]).toHaveBeenCalledTimes(1);
});
