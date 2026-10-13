// The tutorials offered in Help → Hands-on Tutorials and on the start screen.
// Titles only: the steps (tutorials.ts) load with the tutorial engine.
import type { SampleId } from './samples';

export type TutorialInfo = { id: string; title: string; summary: string; minutes: number; sample: SampleId };

export const TUTORIALS: TutorialInfo[] = [
  { id: 'layers', title: 'Layers basics', summary: 'Add a layer, paint on it without touching the photo, then change its opacity and visibility.', minutes: 3, sample: 'meadow' },
  { id: 'masking', title: 'Masking a subject', summary: 'Select an object, hide everything around it with a layer mask and refine the edge with a brush.', minutes: 4, sample: 'subject' },
  { id: 'adjustments', title: 'Adjustment layers', summary: 'Brighten a flat image with an adjustment layer you can change or switch off at any time.', minutes: 3, sample: 'hazy-hills' },
  { id: 'retouch', title: 'Retouching a blemish', summary: 'Zoom in and remove small spots with one click each.', minutes: 2, sample: 'skin' },
  { id: 'text-shapes', title: 'Text and shapes', summary: 'Add a title, draw a shape behind it and give it a shadow.', minutes: 4, sample: 'poster' },
  { id: 'exporting', title: 'Exporting your work', summary: 'Export a copy for the web, repeat it in one click and keep an editable project.', minutes: 2, sample: 'postcard' },
];
export const tutorialInfo = (id: string) => TUTORIALS.find((t) => t.id === id);
