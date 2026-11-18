// Steps for File → Automate (Image Processor and Batch). Features register
// steps at startup; the processor itself (automate.ts) loads on first use.
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { lazy } from '../../app/lazy';
import type { RGBA8 } from '../../imaging/types';

const processor = lazy(() => import('./automate'));
/** A processing step for Image Processor / Batch. Pixel steps transform the
 * decoded image; document steps run in the editor on the opened file (for
 * recorded actions) before it is flattened and saved. */
export type BatchStep = {
  id: string;
  label: string;
  apply?: (image: RGBA8, info: { name: string }) => RGBA8 | Promise<RGBA8>;
  document?: (e: Editor) => Promise<void>;
  /** Batch starts with this step ticked (the action chosen in the Actions panel). */
  preselected?: () => boolean;
};
export const batchSteps = new Map<string, BatchStep>();
const steps = batchSteps;
let editorRef: Editor | undefined;
export function registerBatchStep(step: BatchStep) {
  steps.set(step.id, step);
  // Batch is only offered once there is something to run.
  if (editorRef) registerBatchCommand(editorRef);
}
function registerBatchCommand(e: Editor) {
  registerCommand({ id: 'file.batch', label: 'Batch…', run: async () => (await processor()).imageProcessor(e, true), prefetch: processor.prefetch, recordable: false, description: 'Run steps on many files and save the results' });
}
export function installAutomate(e: Editor) {
  editorRef = e;
  registerCommand({ id: 'file.image-processor', label: 'Image Processor…', run: async () => (await processor()).imageProcessor(e, false), prefetch: processor.prefetch, recordable: false, description: 'Convert and resize many images at once' });
  if (steps.size) registerBatchCommand(e);
}

