// Runs the export pipeline (resample, convert, encode) off the main thread so
// previews and batch jobs keep the editor responsive.
import { encodeGif, type GifEncodeFrame, type GifEncodeOptions } from '../../imaging/codecs/gif';
import { encodeExport, prepareExport, type ExportContext, type ExportSettings, type SourceImage } from './encode';
import { printPng } from './print-encode';

type Job =
  | { id: number; src: SourceImage; settings: ExportSettings; ctx: ExportContext; keepPrepared: boolean; owned?: boolean; prepareOnly?: boolean; gif?: undefined; print?: undefined }
  | { id: number; gif: { frames: GifEncodeFrame[]; options: GifEncodeOptions }; print?: undefined }
  | { id: number; print: { src: SourceImage; ctx: ExportContext; owned: boolean }; gif?: undefined };
self.onmessage = async (event: MessageEvent<Job>) => {
  const job = event.data;
  const { id } = job;
  try {
    if (job.gif) {
      const bytes = encodeGif(job.gif.frames, job.gif.options);
      (self as unknown as Worker).postMessage({ id, bytes }, [bytes.buffer as ArrayBuffer]);
      return;
    }
    if (job.print) {
      const bytes = printPng(job.print.src, job.print.ctx, job.print.owned);
      (self as unknown as Worker).postMessage({ id, bytes }, [bytes.buffer as ArrayBuffer]);
      return;
    }
    const { src, settings, ctx, keepPrepared, owned } = job;
    const prepared = prepareExport(src, settings, ctx, owned);
    if (job.prepareOnly) {
      (self as unknown as Worker).postMessage({ id, bytes: new Uint8Array(0), prepared }, [prepared.data.buffer as ArrayBuffer]);
      return;
    }
    const bytes = await encodeExport(prepared, settings, ctx);
    const transfer: Transferable[] = [bytes.buffer as ArrayBuffer];
    if (keepPrepared) transfer.push(prepared.data.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ id, bytes, prepared: keepPrepared ? prepared : undefined }, transfer);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
