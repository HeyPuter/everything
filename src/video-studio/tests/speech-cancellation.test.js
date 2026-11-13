import {it,expect,vi,afterEach} from 'vitest';
import {transcribePiece,transcribeMix} from '../src/media/transcribe.js';
afterEach(()=>{delete globalThis.puter;});
const samples=new Float32Array(16000);
const words={words:[{text:'Hello',start:0,end:.5}]};
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{resolve,reject,promise};};
it('does not request speech for an already cancelled piece',async()=>{
 const controller=new AbortController();controller.abort();const speech=vi.fn().mockResolvedValue(words);globalThis.puter={ai:{speech2txt:speech}};
 await expect(transcribePiece(samples,16000,{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(speech).not.toHaveBeenCalled();
});
it('does not start fallback after a primary failure arrives after cancellation',async()=>{
 const controller=new AbortController(),pending=deferred(),speech=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(words);globalThis.puter={ai:{speech2txt:speech}};
 const done=transcribeMix(samples,16000,{signal:controller.signal}).catch(e=>e);controller.abort();pending.reject(new Error('Primary failed'));
 expect(await done).toMatchObject({name:'AbortError'});expect(speech).toHaveBeenCalledTimes(1);
});
it('keeps cancellation distinct from a late fallback failure',async()=>{
 const controller=new AbortController(),pending=deferred(),speech=vi.fn().mockRejectedValueOnce(new Error('Primary failed')).mockReturnValueOnce(pending.promise);globalThis.puter={ai:{speech2txt:speech}};
 const done=transcribeMix(samples,16000,{signal:controller.signal}).catch(e=>e);await vi.waitFor(()=>expect(speech).toHaveBeenCalledTimes(2));controller.abort();pending.reject(new Error('Fallback failed'));
 expect(await done).toMatchObject({name:'AbortError'});expect(speech).toHaveBeenCalledTimes(2);
});
it('still retries genuine primary errors and retains language and word timestamps',async()=>{
 const speech=vi.fn().mockRejectedValueOnce(new Error('Primary failed')).mockResolvedValue(words);globalThis.puter={ai:{speech2txt:speech}};
 expect(await transcribePiece(samples,16000,{language:'fr'})).toEqual(words.words);expect(speech).toHaveBeenCalledTimes(2);expect(speech.mock.calls[0][0]).toMatchObject({provider:'xai',language:'fr'});expect(speech.mock.calls[1][1]).toEqual({language:'fr'});
});
it('keeps real fallback errors visible when not cancelled',async()=>{
 const speech=vi.fn().mockRejectedValueOnce(new Error('Primary failed')).mockRejectedValueOnce(new Error('Fallback failed'));globalThis.puter={ai:{speech2txt:speech}};
 await expect(transcribeMix(samples,16000)).rejects.toThrow('Fallback failed');expect(speech).toHaveBeenCalledTimes(2);
});
