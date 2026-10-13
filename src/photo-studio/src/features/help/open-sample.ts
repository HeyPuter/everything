// Open a generated sample as a new, untitled document (not added to the
// recent files list).
import type { Editor } from '../../editor';
import { newDocument } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { makeBackground } from '../../model/housekeeping';
import { emitAppEvent } from '../../app/app-events';
import { makeSample, type SampleId } from './samples';

export async function openSample(e: Editor, id: SampleId) {
  const sample = makeSample(id);
  e.transform.apply();
  const s = e.sessionForOpen();
  await e.renderer?.settle();
  const doc = newDocument(sample.width, sample.height, sample.name);
  const layers = sample.layers.map((l) => {
    const layer = newPixelLayer(l.name, doc, gridFromImage(s.assets.tiles, l.image));
    if (l.background) makeBackground(layer);
    return layer;
  });
  s.history.reset({ ...doc, layers });
  s.hasDocument = true;
  s.saved = undefined;
  e.selected = layers.at(-1)!.id;
  e.fit();
  e.update();
  void emitAppEvent('new-document', s);
}
