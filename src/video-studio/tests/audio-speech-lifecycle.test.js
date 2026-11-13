import {it,expect,vi,afterEach} from 'vitest';
import {audioTab} from '../src/ui/panels/audio.js';
import {EditorStore} from '../src/model/store.js';
import {createProject,makeClip,makeTrack,normalizeAsset} from '../src/model/project.js';
import {addTimeline} from '../src/model/timelines.js';
import {createCompound} from '../src/model/compound.js';
import {createActions} from '../src/ui/actions.js';
import {Emitter} from '../src/lib/emitter.js';
const tabs=[];let serial=0;
afterEach(()=>{tabs.splice(0).forEach(t=>t.dispose());delete globalThis.puter;document.querySelectorAll('.toast').forEach(t=>t.remove());document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const tick=()=>new Promise(r=>setTimeout(r,0));
const button=(root,label)=>[...root.querySelectorAll('button')].find(b=>b.textContent===label);
const audioClips=store=>store.project.tracks.flatMap(t=>t.clips).filter(c=>c.type==='audio');
function setup(){
 const p=createProject(),n=++serial,caption=makeClip('text',{text:'Selected speech '+n,start:400000,duration:1000000}),other=makeClip('text',{text:'Other text '+n,start:3000000,duration:1000000});p.tracks.push(makeTrack('text',{clips:[caption,other]}));const nested=makeClip('text',{text:'Nested',duration:1000000});p.tracks[0].clips.push(nested);const compound=createCompound(p,[nested.id]),target=addTimeline(p),original=p.timelineId,store=new EditorStore(p),player=new Emitter(),provider=vi.fn();globalThis.puter={ai:{txt2speech:provider}};
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,blob:async()=>new Blob(['speech'],{type:'audio/wav'})}),library={backend:{kind:'puter'},importFile:vi.fn(async()=>normalizeAsset({id:'speech',name:'Speech.wav',kind:'audio',duration:1000000,hasAudio:true}))},ctx={store,player,library,account:{}};ctx.actions=createActions(ctx);
 const audios=[],playResults=[];vi.stubGlobal('Audio',class extends EventTarget{constructor(src){super();this.src=src;this.pause=vi.fn();this.play=vi.fn(()=>playResults.length?playResults.shift():Promise.resolve());audios.push(this);}});const urls=vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:preview-${n}-${audios.length}`),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
 const tab=audioTab(ctx);tabs.push(tab);document.body.append(tab.el);tab.el.querySelector('[data-cat=create-group]')?.click();tab.el.querySelector('[data-cat=tts]').click();const field=tab.el.querySelector('textarea.tts-text');field.value='Typed speech '+n;field.dispatchEvent(new Event('input'));const add=button(tab.el,'Add to timeline'),preview=button(tab.el,'Preview');return{ctx,store,player,tab,field,add,preview,provider,fetch,library,audios,playResults,urls,revoke,target,original,compound,caption,other};
}
function change(env,kind){if(kind==='timeline'||kind==='return'){env.store.openTimeline(env.target);if(kind==='return')env.store.openTimeline(env.original);}else if(kind==='compound')env.store.openCompound(env.compound.id);else if(kind==='project')env.store.load(createProject());else env.tab.dispose();}
it.each(['timeline','compound','project','dispose','return'])('does not download or add obsolete speech after %s',async kind=>{
 const env=setup(),pending=deferred();env.provider.mockReturnValue(pending.promise);env.add.click();change(env,kind);pending.resolve({src:'https://speech.invalid/audio'});await tick();expect(env.fetch).not.toHaveBeenCalled();expect(env.library.importFile).not.toHaveBeenCalled();expect(audioClips(env.store)).toHaveLength(0);
});
it.each(['hidden','playing','category','dispose','timeline'])('does not start a pending preview after %s',async kind=>{
 const env=setup(),pending=deferred();env.provider.mockReturnValue(pending.promise);env.preview.click();if(kind==='hidden')env.tab.hidden();else if(kind==='playing')env.player.emit('play',{playing:true});else if(kind==='category')env.tab.el.querySelector('[data-cat=music]').click();else change(env,kind);pending.resolve({src:'https://speech.invalid/audio'});await tick();expect(env.audios).toHaveLength(0);expect(env.fetch).not.toHaveBeenCalled();
});
it.each(['timeline','category','dispose'])('stops an active preview and releases its URL after %s',async kind=>{
 const env=setup();env.provider.mockResolvedValue({src:'https://speech.invalid/audio'});env.preview.click();await tick();expect(env.audios).toHaveLength(1);if(kind==='category')env.tab.el.querySelector('[data-cat=music]').click();else change(env,kind);expect(env.audios[0].pause).toHaveBeenCalledTimes(1);expect(env.revoke).toHaveBeenCalledWith(env.audios[0].src);
});
it('ignores a stale ended event after a newer preview starts',async()=>{
 const env=setup();env.provider.mockResolvedValue({src:'https://speech.invalid/audio'});env.preview.click();await tick();const old=env.audios[0];env.preview.click();env.field.value+=' new';env.field.dispatchEvent(new Event('input'));env.preview.click();await tick();const fresh=env.audios[1];old.dispatchEvent(new Event('ended'));expect(fresh.pause).not.toHaveBeenCalled();expect(env.preview.textContent).toBe('Stop');
});
it('can cancel, restore focus, and restart without an old result resetting controls',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();env.provider.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);env.add.focus();env.add.click();const cancel=button(env.tab.el,'Cancel speech');expect(cancel).toBeTruthy();cancel.focus();cancel.click();expect(env.add.disabled).toBe(false);expect(document.activeElement).toBe(env.add);env.add.click();old.resolve({src:'https://speech.invalid/old'});await tick();expect(env.add.disabled).toBe(true);expect(env.fetch).not.toHaveBeenCalled();fresh.resolve({src:'https://speech.invalid/fresh'});await tick();expect(audioClips(env.store)).toHaveLength(1);
});
it('does not let an obsolete import clear a newer job status',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();env.provider.mockResolvedValueOnce({src:'https://speech.invalid/old'}).mockReturnValueOnce(fresh.promise);env.library.importFile.mockReturnValueOnce(old.promise);env.add.click();await vi.waitFor(()=>expect(env.library.importFile).toHaveBeenCalledTimes(1));env.store.openTimeline(env.target);env.field.value+=' fresh';env.field.dispatchEvent(new Event('input'));env.add.click();old.resolve(normalizeAsset({id:'old',kind:'audio',duration:1000000}));await tick();expect(env.add.disabled).toBe(true);expect(env.tab.el.querySelector('.tts-status').textContent).toContain('Creating speech');fresh.resolve({src:'https://speech.invalid/fresh'});await tick();expect(audioClips(env.store)).toHaveLength(1);
});
it('captures requested words and placement while the user prepares another text',async()=>{
 const env=setup(),pending=deferred();env.store.select(env.caption.id);button(env.tab.el,'Use selected text').click();const words=env.field.value;env.provider.mockReturnValue(pending.promise);env.add.click();env.store.select(env.other.id);button(env.tab.el,'Use selected text').click();pending.resolve({src:'https://speech.invalid/audio'});await tick();expect(env.provider.mock.calls[0][0]).toBe(words);expect(env.library.importFile.mock.calls[0][0].name).toContain('Selected speech');expect(audioClips(env.store)[0].start).toBe(400000);
});
it('uses the playhead at invocation and preserves undo alongside a rename',async()=>{
 const env=setup(),pending=deferred();env.store.seek(700000);env.provider.mockReturnValue(pending.promise);env.add.click();env.store.seek(2000000);env.store.update('Rename',p=>{p.name='Renamed';});pending.resolve({src:'https://speech.invalid/audio'});await tick();expect(audioClips(env.store)[0].start).toBe(700000);env.store.undo();expect(audioClips(env.store)).toHaveLength(0);expect(env.store.project.name).toBe('Renamed');
});
it('clears an obsolete selected-text placement hint when context changes',()=>{
 const env=setup();env.store.select(env.caption.id);button(env.tab.el,'Use selected text').click();expect(env.tab.el.querySelector('.tts-where').textContent).toContain('selected text');env.store.openTimeline(env.target);expect(env.tab.el.querySelector('.tts-where').textContent).toBe('Speech is added at the playhead.');
});
it('lets an add job finish when only the panel is hidden',async()=>{
 const env=setup(),pending=deferred();env.provider.mockReturnValue(pending.promise);env.add.click();env.tab.hidden();pending.resolve({src:'https://speech.invalid/audio'});await tick();expect(audioClips(env.store)).toHaveLength(1);
});
it('reports an active failure and supports a normal retry',async()=>{
 const env=setup(),pending=deferred();env.provider.mockReturnValueOnce(pending.promise).mockResolvedValue({src:'https://speech.invalid/audio'});env.add.click();pending.reject(Error('Speech request failed'));await tick();expect(env.add.disabled).toBe(false);expect(document.body.textContent).toContain('Speech request failed');env.add.click();await tick();expect(audioClips(env.store)).toHaveLength(1);
});
it('can restart after stopping a pending play promise without its late rejection stopping the new preview',async()=>{
 const env=setup(),pending=deferred();env.playResults.push(pending.promise);env.provider.mockResolvedValue({src:'https://speech.invalid/audio'});env.preview.click();await tick();env.tab.hidden();expect(env.preview.disabled).toBe(false);env.field.value+=' fresh';env.field.dispatchEvent(new Event('input'));env.preview.click();await tick();const fresh=env.audios[1];pending.reject(Error('Old play failed'));await tick();expect(fresh.pause).not.toHaveBeenCalled();expect(env.preview.textContent).toBe('Stop');
});
it('does not report an obsolete provider failure or reset fresh controls',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();env.provider.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);env.add.click();env.store.openTimeline(env.target);env.add.click();old.reject(Error('Obsolete provider failed'));await tick();expect(env.add.disabled).toBe(true);expect(document.body.textContent).not.toContain('Obsolete provider failed');fresh.resolve({src:'https://speech.invalid/fresh'});await tick();expect(audioClips(env.store)).toHaveLength(1);
});
it('plays and stops a normal preview and releases its URL only once',async()=>{
 const env=setup();env.provider.mockResolvedValue({src:'https://speech.invalid/audio'});env.preview.click();await tick();const playing=env.audios[0];expect(playing.play).toHaveBeenCalledTimes(1);expect(env.preview.textContent).toBe('Stop');env.preview.click();playing.dispatchEvent(new Event('ended'));expect(playing.pause).toHaveBeenCalledTimes(1);expect(env.revoke).toHaveBeenCalledTimes(1);expect(env.preview.textContent).toBe('Preview');expect(env.add.disabled).toBe(false);
});
