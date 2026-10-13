// The AI options of Portrait & Restore (AI colors, AI style, Scene Changer):
// instructions for Puter's image-to-image service. Requests run only from the
// buttons in the workspace, which say what is sent before anything is.
import { SCENE_PRESETS, type RestoreEntry } from '../../imaging/restore/defs';
import { toAIError, transformImage } from '../../imaging/ai/puter-ai';
import type { RGBA8 } from '../../imaging/types';
import { ensureSignedIn } from '../retouch/ai';

const KEEP = 'Keep the composition, framing, perspective, people and every object exactly where they are, and return the full image with the same aspect ratio.';

/** The complete instruction for an entry, or undefined when its prompt is missing. */
export function aiInstruction(en: RestoreEntry): string | undefined {
  if (en.id === 'colorize')
    return 'Colorize this black-and-white photograph with natural, realistic and historically plausible colors. Only add color: keep every detail, the lighting and the tones exactly as they are. ' + KEEP;
  if (en.id === 'style') {
    const p = (en.prompt ?? '').trim();
    if (!p) return undefined;
    return `Restyle this photo as ${p.replace(/[.\s]+$/, '')}. If a second image is given, use it only as a reference for the style (colors, brushwork, texture), never for content. ${KEEP}`;
  }
  if (en.id === 'scene') {
    const preset = SCENE_PRESETS.find((s) => s.id === en.params.preset);
    const what = preset?.id === 'custom' || !preset ? (en.prompt ?? '').trim().replace(/[.\s]+$/, '') : preset.prompt;
    if (!what) return undefined;
    return `Edit this photo to show ${what}. Change only the light, sky, season or weather as described. ${KEEP}`;
  }
  return undefined;
}

/** A short description kept with layers made from AI results. */
export function aiSummary(en: RestoreEntry): string {
  if (en.id === 'colorize') return 'Colorize (AI suggestion)';
  if (en.id === 'style') return `Style: ${(en.prompt ?? '').trim()}`;
  const preset = SCENE_PRESETS.find((s) => s.id === en.params.preset);
  return preset && preset.id !== 'custom' ? `Scene: ${preset.label}` : `Scene: ${(en.prompt ?? '').trim()}`;
}

export type AIRunOptions = { reference?: RGBA8; signal?: AbortSignal; onStatus?: (text: string) => void };

/** Sign in when needed, then send the image and instruction. */
export async function runAI(image: RGBA8, instruction: string, o: AIRunOptions = {}): Promise<RGBA8> {
  try {
    o.onStatus?.('Connecting to Puter…');
    await ensureSignedIn();
    o.onStatus?.('Generating… this can take a little while.');
    return await transformImage(image, instruction, { reference: o.reference, signal: o.signal });
  } catch (error) {
    const err = toAIError(error);
    throw new Error(err.message + (err.retryable ? ' You can try again.' : ''));
  }
}
