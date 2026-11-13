import {it,expect,vi,afterEach} from 'vitest';
import {synthesize,addSpeechToTimeline} from '../src/media/tts.js';
import {EditorStore} from '../src/model/store.js';
import {createProject,normalizeAsset} from '../src/model/project.js';
import {addTimeline} from '../src/model/timelines.js';
import {createActions} from '../src/ui/actions.js';
afterEach(()=>{delete globalThis.puter;document.querySelectorAll('.toast').forEach(t=>t.remove());document.body.replaceChildren();vi.restoreAllMocks();});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
let serial=0;const text=()=>`Cancellation voice ${++serial}`;
function provider(){const call=vi.fn();globalThis.puter={ai:{txt2speech:call}};return call;}
function importContext(){const store=new EditorStore(createProject()),target=addTimeline(store.project),library={importFile:vi.fn()};const ctx={store,library};ctx.actions=createActions(ctx);return{ctx,store,target,library};}
const asset=()=>normalizeAsset({id:'speech',kind:'audio',name:'Speech.wav',duration:1000000,hasAudio:true});
const blob=()=>new Blob(['voice'],{type:'audio/wav'});
it('rejects already-cancelled speech without requesting or fetching',async()=>{
 const call=provider(),fetch=vi.spyOn(globalThis,'fetch'),abort=new AbortController();abort.abort();await expect(synthesize(text(),'polly',{signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});expect(call).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it.each(['reply','error'])('preserves cancellation after a late provider %s',async kind=>{
 const call=provider(),pending=deferred(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,blob:async()=>blob()}),abort=new AbortController();call.mockReturnValue(pending.promise);const done=synthesize(text(),'polly',{signal:abort.signal}).catch(e=>e);abort.abort();if(kind==='reply')pending.resolve({src:'https://speech.invalid/voice'});else pending.reject(Error('Provider failed'));expect(await done).toMatchObject({name:'AbortError'});expect(fetch).not.toHaveBeenCalled();
});
it('does not cache a download that completes after cancellation',async()=>{
 const call=provider(),pending=deferred(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce({ok:true,blob:()=>pending.promise}).mockResolvedValue({ok:true,blob:async()=>blob()}),abort=new AbortController(),words=text();call.mockResolvedValue({src:'https://speech.invalid/voice'});const done=synthesize(words,'polly',{signal:abort.signal}).catch(e=>e);await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));abort.abort();pending.resolve(blob());expect(await done).toMatchObject({name:'AbortError'});await synthesize(words,'polly');expect(call).toHaveBeenCalledTimes(2);expect(fetch).toHaveBeenCalledTimes(2);
});
it('retains ordinary synthesis caching and voice/test-mode options',async()=>{
 const call=provider(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,blob:async()=>blob()}),words=text();call.mockResolvedValue({src:'https://speech.invalid/voice'});const first=await synthesize(words,'openai-nova',{testMode:true});expect(await synthesize(words,'openai-nova',{testMode:true})).toBe(first);expect(call).toHaveBeenCalledTimes(1);expect(call).toHaveBeenCalledWith(words,{provider:'openai',voice:'nova',test_mode:true});expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not register or insert an import from a different context without a caller signal',async()=>{
 const {ctx,store,target,library}=importContext(),pending=deferred();library.importFile.mockReturnValue(pending.promise);const done=addSpeechToTimeline(ctx,blob(),'Hello',{start:300000}).catch(e=>e);store.openTimeline(target);pending.resolve(asset());expect(await done).toMatchObject({name:'AbortError'});expect(store.project.assets.speech).toBeUndefined();expect(store.project.tracks.flatMap(t=>t.clips)).toHaveLength(0);expect(ctx.imports.size).toBe(0);
});
it('rejects an already-cancelled speech import before touching the library',async()=>{
 const {ctx,library}=importContext(),abort=new AbortController();abort.abort();await expect(addSpeechToTimeline(ctx,blob(),'Hello',{signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});expect(library.importFile).not.toHaveBeenCalled();
});
it('stops a cancelled batch import before registering assets or reading the next file',async()=>{
 const {ctx,store,library}=importContext(),pending=deferred(),abort=new AbortController();library.importFile.mockReturnValueOnce(pending.promise).mockResolvedValue(asset());const done=ctx.actions.importFiles([new File(['one'],'one.wav'),new File(['two'],'two.wav')],{signal:abort.signal}).catch(e=>e);abort.abort();pending.resolve(asset());expect(await done).toMatchObject({name:'AbortError'});expect(library.importFile).toHaveBeenCalledTimes(1);expect(Object.keys(store.project.assets)).toHaveLength(0);
});
it('does not report a late cancelled import failure as a current error',async()=>{
 const {ctx,library}=importContext(),pending=deferred(),abort=new AbortController(),error=vi.spyOn(console,'error').mockImplementation(()=>{});library.importFile.mockReturnValue(pending.promise);const done=ctx.actions.importFiles([new File(['one'],'one.wav')],{signal:abort.signal}).catch(e=>e);abort.abort();pending.reject(Error('Old import failed'));expect(await done).toMatchObject({name:'AbortError'});expect(error).not.toHaveBeenCalled();expect(document.body.textContent).not.toContain('Old import failed');
});
it.each(['fetch','body'])('keeps AbortError when a cancelled %s fails late',async stage=>{
 const call=provider(),pending=deferred(),body=vi.fn(()=>pending.promise),fetch=vi.spyOn(globalThis,'fetch'),abort=new AbortController();call.mockResolvedValue({src:'https://speech.invalid/voice'});if(stage==='fetch')fetch.mockReturnValue(pending.promise);else fetch.mockResolvedValue({ok:true,blob:body});const done=synthesize(text(),'polly',{signal:abort.signal}).catch(e=>e);await vi.waitFor(()=>expect(stage==='fetch'?fetch:body).toHaveBeenCalledTimes(1));abort.abort();pending.reject(Error('Late download failed'));expect(await done).toMatchObject({name:'AbortError'});
});
