import { it, expect, vi, afterEach } from 'vitest';
import { captionsTab, prepareCaptions, generateCaptions } from '../src/ui/panels/captions.js';
import { mixdown } from '../src/media/transcribe.js';
import { createAssistantRunner } from '../src/ui/assistant-actions.js';
import { createActions } from '../src/ui/actions.js';
import { EditorStore } from '../src/model/store.js';
import { addTimeline } from '../src/model/timelines.js';
import { createCompound } from '../src/model/compound.js';
import { makeTrack, makeClip } from '../src/model/project.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';
vi.mock('../src/media/transcribe.js', async orig => ({ ...await orig(), mixdown: vi.fn(async () => new Float32Array(16000)) }));
const tabs=[];
afterEach(()=>{tabs.splice(0).forEach(t=>t.dispose());delete globalThis.puter;delete globalThis.__vsFakeTranscript;document.body.replaceChildren();vi.clearAllMocks();});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{resolve,promise};};
const response=text=>({words:[{text,start:0.1,end:0.4}]});
const captions=store=>store.project.tracks.flatMap(t=>t.clips).filter(c=>c.caption).map(c=>c.text);
const captionTrack=text=>makeTrack('text',{clips:[makeClip('text',{caption:true,text,duration:1000000})]});
const button=(root,label)=>[...root.querySelectorAll('button')].find(b=>b.textContent===label);
function setup({ui=false}={}){
 const p=fixture();const [,nested]=onMain(p,clip('video',0,1),clip('video',1,1));const compound=createCompound(p,[nested.id]);p.tracks.push(captionTrack('Source captions'));const target=addTimeline(p),original=p.timelineId;
 const other=p.timelines.find(t=>t.id===target);other.tracks[0].clips.push(clip('video',0,1));other.tracks.push(captionTrack('Keep these captions'));
 const store=new EditorStore(p),ai=vi.fn();globalThis.puter={ai:{speech2txt:ai}};
 const ctx={store,library:{backend:{kind:'puter'}},player:null,account:{}};
 let tab,generate;
 if(ui){setPref('captionOpts',{});tab=captionsTab(ctx);tabs.push(tab);document.body.append(tab.el);tab.el.querySelector('[data-cat=auto]').click();generate=button(tab.el.querySelector('.cap-form'),'Generate');}
 return{store,ctx,ai,target,original,compound,tab,generate};
}

it.each(['timeline','compound'])('does not apply delayed captions to another %s',async kind=>{
 const {store,ctx,ai,target,compound}=setup(),pending=deferred();ai.mockReturnValueOnce(pending.promise);
 const done=generateCaptions(ctx,{scope:'all'},{mode:'replace'}).then(()=>null,e=>e);
 await vi.waitFor(()=>expect(ai).toHaveBeenCalledTimes(1));
 if(kind==='timeline')store.openTimeline(target);else store.openCompound(compound.id);
 const expected=captions(store);pending.resolve(response('Wrong timeline'));
 const error=await done;expect(captions(store)).toEqual(expected);expect(error?.name).toBe('AbortError');
});

it('checks the editing context before starting speech after preparation',async()=>{
 const {store,ctx,ai,target}=setup(),pending=deferred();mixdown.mockImplementationOnce(()=>pending.promise);
 const done=generateCaptions(ctx,{scope:'all'}).then(()=>null,e=>e);store.openTimeline(target);pending.resolve(new Float32Array(16000));
 expect((await done)?.name).toBe('AbortError');expect(ai).not.toHaveBeenCalled();
});

it.each(['timeline','abort'])('rechecks %s when a prepared caption edit is applied',async change=>{
 const {store,ctx,ai,target}=setup(),controller=new AbortController();ai.mockResolvedValue(response('Prepared'));
 const apply=await prepareCaptions(ctx,{scope:'all'},{mode:'replace',signal:controller.signal});
 if(change==='timeline')store.openTimeline(target);else controller.abort();
 const expected=captions(store);expect(()=>apply()).toThrow(expect.objectContaining({name:'AbortError'}));expect(captions(store)).toEqual(expected);
});

it.each(['timeline','dispose'])('closes an obsolete replacement prompt on %s without starting work',async change=>{
 const {store,ai,target,tab,generate}=setup({ui:true});generate.click();
 const dialog=document.querySelector('dialog');expect(dialog?.open).toBe(true);
 if(change==='timeline')store.openTimeline(target);else tab.dispose();
 expect(dialog.open).toBe(false);await new Promise(r=>setTimeout(r,0));expect(ai).not.toHaveBeenCalled();expect(mixdown).not.toHaveBeenCalled();
});

it('opens only one replacement prompt for repeated Generate clicks',()=>{
 const {generate}=setup({ui:true});generate.click();generate.click();expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
});

it.each(['timeline','dispose'])('ignores delayed panel output after %s',async change=>{
 const {store,ai,target,tab,generate}=setup({ui:true}),pending=deferred();ai.mockReturnValueOnce(pending.promise);
 generate.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(ai).toHaveBeenCalledTimes(1));
 if(change==='timeline')store.openTimeline(target);else tab.dispose();const expected=captions(store);
 pending.resolve(response('Wrong timeline'));await new Promise(r=>setTimeout(r,0));expect(captions(store)).toEqual(expected);expect(document.body.textContent).not.toContain('Added 1 caption.');
});

it('lets a cancelled panel job restart without an old completion resetting its progress',async()=>{
 const {store,ai,tab,generate}=setup({ui:true}),old=deferred(),fresh=deferred();ai.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 generate.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(ai).toHaveBeenCalledTimes(1));
 button(tab.el,'Cancel').click();expect(generate.disabled).toBe(false);
 generate.click();button(document.querySelector('dialog[open]'),'Replace').click();await vi.waitFor(()=>expect(ai).toHaveBeenCalledTimes(2));
 old.resolve(response('Old'));await new Promise(r=>setTimeout(r,0));expect(generate.disabled).toBe(true);expect(tab.el.querySelector('.cap-progress').hidden).toBe(false);
 fresh.resolve(response('Fresh'));await vi.waitFor(()=>expect(captions(store)).toEqual(['Fresh']));expect(generate.disabled).toBe(false);
});

it('preserves same-timeline edits, locked captions, and the caption undo step',async()=>{
 const {store,ctx,ai}=setup(),pending=deferred();const locked=captionTrack('Locked');locked.locked=true;store.project.tracks.push(locked);ai.mockReturnValueOnce(pending.promise);
 const done=generateCaptions(ctx,{scope:'all'},{mode:'replace'});await vi.waitFor(()=>expect(ai).toHaveBeenCalledTimes(1));
 store.update('Rename',p=>{p.name='Renamed';});pending.resolve(response('Fresh'));expect(await done).toBe(1);expect(captions(store).sort()).toEqual(['Fresh','Locked']);
 store.undo();expect(store.project.name).toBe('Renamed');expect(captions(store).sort()).toEqual(['Locked','Source captions']);
});

it('invalidates a panel job even when the same timeline is reopened before it finishes',async()=>{
 const {store,ai,target,original,tab,generate}=setup({ui:true}),pending=deferred();ai.mockReturnValueOnce(pending.promise);
 generate.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(ai).toHaveBeenCalledTimes(1));
 store.openTimeline(target);store.openTimeline(original);expect(generate.disabled).toBe(false);
 pending.resolve(response('Obsolete'));await new Promise(r=>setTimeout(r,0));expect(captions(store)).toEqual(['Source captions']);
 expect(tab.el.querySelector('.cap-progress').hidden).toBe(true);
});

it('does not let cancelled preparation report progress or an error over its replacement',async()=>{
 const {tab,generate,ai}=setup({ui:true}),old=deferred(),fresh=deferred();let oldProgress,newProgress;
 mixdown.mockImplementationOnce((_p,_l,o)=>{oldProgress=o.onProgress;return old.promise;});
 mixdown.mockImplementationOnce((_p,_l,o)=>{newProgress=o.onProgress;return fresh.promise;});
 generate.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(oldProgress).toBeTypeOf('function'));
 button(tab.el,'Cancel').click();generate.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(newProgress).toBeTypeOf('function'));
 newProgress(.3);const before=tab.el.querySelector('[role="progressbar"]').getAttribute('aria-valuenow');oldProgress(.9);old.resolve(Promise.reject(new Error('Obsolete failure')));
 await new Promise(r=>setTimeout(r,0));expect(generate.disabled).toBe(true);expect(tab.el.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe(before);expect(document.body.textContent).not.toContain('Obsolete failure');
 tab.dispose();fresh.resolve(new Float32Array(16000));await new Promise(r=>setTimeout(r,0));expect(ai).not.toHaveBeenCalled();
});

it('releases the job observer on success, cancellation and disposal',async()=>{
 const {store,ai,tab,generate}=setup({ui:true});const original=store.on.bind(store);let live=0;
 vi.spyOn(store,'on').mockImplementation((type,fn)=>{live++;const off=original(type,fn);return()=>{live--;off();};});
 ai.mockResolvedValue(response('Fresh'));
 generate.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(captions(store)).toEqual(['Fresh']));expect(live).toBe(0);
 generate.click();expect(live).toBe(1);button(document.querySelector('dialog'),'Cancel').click();await vi.waitFor(()=>expect(live).toBe(0));expect(generate.disabled).toBe(false);
 generate.click();expect(live).toBe(1);tab.dispose();expect(live).toBe(0);
});

it('restores focus to Generate after cancelling its replacement prompt',async()=>{
 const {generate}=setup({ui:true});generate.focus();generate.click();button(document.querySelector('dialog'),'Cancel').click();await new Promise(r=>setTimeout(r,0));expect(document.activeElement).toBe(generate);expect(generate.disabled).toBe(false);
});

it('returns keyboard focus to Generate when cancelling active work',async()=>{
 const {tab,ai,generate}=setup({ui:true}),pending=deferred();ai.mockReturnValueOnce(pending.promise);
 generate.click();button(document.querySelector('dialog'),'Replace').click();await vi.waitFor(()=>expect(ai).toHaveBeenCalledTimes(1));
 const cancel=button(tab.el,'Cancel');cancel.focus();cancel.click();expect(document.activeElement).toBe(generate);
 pending.resolve(response('Old'));
});

it('applies real prepared captions through the assistant as one undoable edit',async()=>{
 const {store,ctx,ai}=setup();ctx.actions=createActions(ctx);ai.mockResolvedValue(response('Assistant captions'));
 const runner=createAssistantRunner(ctx);const {results}=await runner.run([{name:'add_captions',args:{scope:'all',replace_existing:true}}]);
 expect(results.map(r=>r.ok)).toEqual([true]);expect(captions(store)).toEqual(['Assistant captions']);expect(store.history.undoStack).toHaveLength(1);
 store.undo();expect(captions(store)).toEqual(['Source captions']);
});
