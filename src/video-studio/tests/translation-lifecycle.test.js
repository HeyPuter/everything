import {it,expect,vi,afterEach} from 'vitest';
import {captionsTab} from '../src/ui/panels/captions.js';
import {EditorStore} from '../src/model/store.js';
import {createProject,makeTrack,makeClip} from '../src/model/project.js';
import {addTimeline} from '../src/model/timelines.js';
import {createCompound} from '../src/model/compound.js';
import {setPref} from '../src/ui/prefs.js';
import {closeMenus} from '../src/ui/menu.js';
const tabs=[];
afterEach(()=>{closeMenus();tabs.splice(0).forEach(t=>t.dispose());document.querySelectorAll('dialog').forEach(d=>d.dispatchEvent(new Event('cancel',{cancelable:true})));document.querySelectorAll('.toast').forEach(t=>t.remove());document.body.replaceChildren();delete globalThis.puter;vi.restoreAllMocks();});
const tick=()=>new Promise(r=>setTimeout(r,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const track=(text,locked=false)=>makeTrack('text',{locked,clips:[makeClip('text',{caption:true,text,start:100000,duration:900000})]});
const texts=store=>store.project.tracks.flatMap(t=>t.clips).filter(c=>c.caption).map(c=>c.text);
const button=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
function setup({mode='track',count=1,locked=false}={}){
 const p=createProject();const nested=makeClip('text',{text:'Nested',duration:1000000});p.tracks[0].clips.push(nested);const compound=createCompound(p,[nested.id]);for(let i=0;i<count;i++)p.tracks.push(track(i?'Hello '+i:'Hello'));if(locked)p.tracks.push(track('Locked',true));const target=addTimeline(p),original=p.timelineId;p.timelines.find(t=>t.id===target).tracks.push(track('Destination'));
 const store=new EditorStore(p),chat=vi.fn();globalThis.puter={ai:{chat}};setPref('translateMode',mode);setPref('translateTo','es');const tab=captionsTab({store,library:{backend:{kind:'puter'}},account:{},player:null});tabs.push(tab);document.body.append(tab.el);tab.el.querySelector('[data-cat=list]').click();const ai=button(tab.el,'AI');return{store,tab,chat,target,original,compound,ai};
}
function open(env){env.ai.focus();env.ai.click();const item=button(document.querySelector('[role=menu]'),'Translate captions...');item.click();return{item,dialog:document.querySelector('dialog[open]')};}
function start(env,pending){env.chat.mockReturnValueOnce(pending.promise);const out=open(env);out.go=button(out.dialog,'Translate');out.go.click();return out;}
it.each(['timeline','compound','project','dispose','return'])('closes the translation and discards late results after %s',async kind=>{
 const env=setup(),pending=deferred(),{dialog}=start(env,pending);
 if(kind==='timeline'||kind==='return'){env.store.openTimeline(env.target);if(kind==='return')env.store.openTimeline(env.original);}else if(kind==='compound')env.store.openCompound(env.compound.id);else if(kind==='project')env.store.load(createProject());else env.tab.dispose();
 const closed=!dialog.open,expected=texts(env.store);pending.resolve('["Hola"]');await tick();expect(texts(env.store)).toEqual(expected);expect(closed).toBe(true);
});
it.each(['timeline','dispose'])('closes an idle translation dialog before it can start after %s',kind=>{
 const env=setup(),{dialog}=open(env);if(kind==='timeline')env.store.openTimeline(env.target);else env.tab.dispose();button(dialog,'Translate').click();expect(env.chat).not.toHaveBeenCalled();expect(dialog.open).toBe(false);
});
it.each(['timeline','dispose'])('does not start the next translation batch after %s',async kind=>{
 const env=setup({count:41}),pending=deferred();start(env,pending);env.chat.mockResolvedValue('["Last"]');if(kind==='timeline')env.store.openTimeline(env.target);else env.tab.dispose();pending.resolve(JSON.stringify(Array(40).fill('Hola')));await tick();expect(env.chat).toHaveBeenCalledTimes(1);
});
it('does not open duplicate translation dialogs or one from a stale menu after disposal',()=>{
 const env=setup(),{item}=open(env);item.click();expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);env.tab.dispose();item.click();expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
});
it('does not let an obsolete response close or update a newer translation',async()=>{
 const env=setup(),old=deferred(),fresh=deferred();start(env,old);env.store.openTimeline(env.target);const next=start(env,fresh);old.resolve('["Old"]');await tick();expect(next.dialog.open).toBe(true);expect(next.go.disabled).toBe(true);expect(texts(env.store)).toEqual(['Destination']);fresh.resolve('["Nuevo"]');await tick();expect(texts(env.store)).toEqual(['Nuevo','Destination']);
});
it.each(['Cancel','Escape'])('keeps captions and focus after %s and permits reopening',async mode=>{
 const env=setup(),pending=deferred(),{dialog}=start(env,pending);if(mode==='Cancel')button(dialog,'Cancel').click();else dialog.dispatchEvent(new Event('cancel',{cancelable:true}));expect(document.activeElement).toBe(env.ai);pending.resolve('["Old"]');await tick();expect(texts(env.store)).toEqual(['Hello']);env.chat.mockResolvedValue('["Fresh"]');const next=open(env);button(next.dialog,'Translate').click();await tick();expect(texts(env.store)).toEqual(['Fresh','Hello']);
});
it('suppresses late provider errors and progress after cancellation',async()=>{
 const env=setup(),pending=deferred(),{dialog}=start(env,pending),status=dialog.querySelector('[role=status]');const error=vi.spyOn(console,'error').mockImplementation(()=>{});button(dialog,'Cancel').click();const before=status.textContent;pending.reject(Error('Late error'));await tick();expect(error).not.toHaveBeenCalled();expect(status.textContent).toBe(before);
});
it('does not update a closed translation progress status',async()=>{
 const env=setup(),pending=deferred(),{dialog}=start(env,pending),status=dialog.querySelector('[role=status]');button(dialog,'Cancel').click();const before=status.textContent;pending.resolve('["Hola"]');await tick();expect(status.textContent).toBe(before);
});
it.each(['track','below','replace'])('preserves normal %s, timing, locks and concurrent edits through undo',async mode=>{
 const env=setup({mode,locked:true}),pending=deferred();start(env,pending);env.store.update('Rename',p=>{p.name='Renamed';});pending.resolve('["Hola","Bloqueado"]');await tick();expect(texts(env.store).sort()).toEqual((mode==='track'?['Hola','Bloqueado','Hello','Locked']:mode==='below'?['Hello\nHola','Locked']:['Hola','Locked']).sort());const translated=env.store.project.tracks.flatMap(t=>t.clips).find(c=>c.text?.includes('Hola'));expect(translated).toMatchObject({start:100000,duration:900000});expect(env.chat).toHaveBeenCalledTimes(1);env.store.undo();expect(texts(env.store)).toEqual(['Hello','Locked']);expect(env.store.project.name).toBe('Renamed');
});
it('reports an active failure and can retry in the same dialog',async()=>{
 const env=setup(),pending=deferred(),{dialog,go}=start(env,pending);vi.spyOn(console,'error').mockImplementation(()=>{});pending.resolve('not JSON');await tick();expect(dialog.open).toBe(true);expect(dialog.querySelector('[role=status]').textContent).toContain('unexpected form');expect(go.disabled).toBe(false);env.chat.mockResolvedValue('["Hola"]');go.click();await tick();expect(texts(env.store)).toEqual(['Hola','Hello']);
});
it('releases the context observer on cancel, success and disposal',async()=>{
 const env=setup(),on=env.store.on.bind(env.store),offs=[];vi.spyOn(env.store,'on').mockImplementation((type,fn)=>{const off=vi.fn(on(type,fn));offs.push(off);return off;});button(open(env).dialog,'Cancel').click();env.chat.mockResolvedValue('["Hola"]');button(open(env).dialog,'Translate').click();await tick();open(env);env.tab.dispose();expect(offs).toHaveLength(3);expect(offs.every(off=>off.mock.calls.length===1)).toBe(true);
});
