/**
 * Prompts for the generative features: the choices the dialogs offer and
 * the text sent to the image and chat models. Pure functions (tested).
 */

export const PROMPT_MAX = 600;

/** What to generate. `phrase` steers the picture toward art that traces well. */
export const CONTENT_TYPES = [
  { id: 'subject', label: 'Subject', phrase: 'one isolated subject, centered, on a plain pure white background, no ground shadow, nothing else in the picture' },
  { id: 'scene', label: 'Scene', phrase: 'a complete scene with a background that fills the whole frame edge to edge' },
  { id: 'icon', label: 'Icon', phrase: 'a single simple bold icon, centered, on a plain pure white background, very few shapes and colors, no text' },
  { id: 'pattern', label: 'Pattern', phrase: 'a seamless repeating pattern tile: motifs spread evenly over the whole square, edge to edge, motifs that cross an edge continue on the opposite edge, no border, no frame' },
];

/** Visual styles (own wording). */
export const STYLES = [
  { id: 'none', label: 'Any style', phrase: '' },
  { id: 'flat', label: 'Flat', phrase: 'flat vector illustration, solid color shapes, no gradients, no texture' },
  { id: 'line', label: 'Line art', phrase: 'clean black line art with even stroke weight, no fills, no shading' },
  { id: 'geometric', label: 'Geometric', phrase: 'built from simple geometric shapes, circles, triangles and rectangles, crisp edges' },
  { id: 'hand', label: 'Hand drawn', phrase: 'hand drawn look with slightly uneven organic outlines, flat colors' },
  { id: 'retro', label: 'Retro', phrase: 'retro mid-century poster style, limited muted palette, bold simple shapes' },
  { id: 'minimal', label: 'Minimal', phrase: 'minimal design, as few shapes as possible, generous negative space' },
  { id: 'isometric', label: 'Isometric', phrase: 'isometric 3D view with flat shaded faces, crisp edges' },
  { id: 'sticker', label: 'Sticker', phrase: 'die-cut sticker style with a thick white outline around the subject, bold flat colors' },
  { id: 'papercut', label: 'Paper cut', phrase: 'layered paper cut-out style, stacked flat layers' },
];

/** Color treatments. `colors` is the most colors the trace keeps (null: by detail). */
export const COLOR_MODES = [
  { id: 'full', label: 'Full color', phrase: '', colors: null },
  { id: 'limited', label: 'Few colors', phrase: 'a limited palette of at most five flat colors', colors: 5 },
  { id: 'mono', label: 'Black and white', phrase: 'black and white only, no gray', colors: 2 },
  { id: 'pastel', label: 'Pastel', phrase: 'soft pastel colors', colors: null },
  { id: 'vivid', label: 'Vivid', phrase: 'bright saturated colors with strong contrast', colors: null },
];

export const DETAIL_LABELS = ['Low', 'Medium', 'High'];

/** Ideas for an empty prompt, per content type (original examples). */
export const PROMPT_IDEAS = {
  subject: ['a fox curled up asleep', 'a vintage bicycle with a basket of lemons', 'a cactus in a terracotta pot', 'a lighthouse on a small rock', 'a cup of coffee with steam swirls', 'a paper airplane'],
  scene: ['a quiet harbor town at sunset', 'a camping tent under a starry sky', 'a city rooftop garden in spring', 'snowy mountains above a pine forest', 'a desert road with a single gas station'],
  icon: ['a padlock', 'a cloud with an upward arrow', 'a shopping bag', 'a leaf', 'a map pin with a heart', 'a gear'],
  pattern: ['tiny strawberries and leaves', 'geometric waves in navy and coral', 'scattered stars and moons', 'tropical monstera leaves', 'folk art flowers'],
};

export const RECOLOR_IDEAS = ['autumn forest at dusk', 'neon arcade', 'sunlit beach and sea glass', 'muted scandinavian interior', 'vintage travel poster', 'deep ocean bioluminescence', 'candy shop', 'earthy desert clay'];

export const TONES = [
  { id: 'friendly', label: 'Friendly' },
  { id: 'professional', label: 'Professional' },
  { id: 'concise', label: 'Concise' },
  { id: 'playful', label: 'Playful' },
  { id: 'persuasive', label: 'Persuasive' },
  { id: 'formal', label: 'Formal' },
];

export const LENGTHS = [
  { id: 'same', label: 'About the same length' },
  { id: 'shorter', label: 'Shorter' },
  { id: 'longer', label: 'Longer' },
];

export const TEXT_KINDS = [
  { id: 'headline', label: 'Headline', ask: 'a headline of at most 8 words' },
  { id: 'tagline', label: 'Tagline', ask: 'a short tagline of at most 12 words' },
  { id: 'paragraph', label: 'Paragraph', ask: 'one paragraph of 40 to 70 words' },
  { id: 'list', label: 'List', ask: 'a list of 3 to 6 short items, one per line, without bullets or numbers' },
  { id: 'cta', label: 'Call to action', ask: 'a short call to action of at most 6 words' },
];

export const LANGUAGES = ['Arabic', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Czech', 'Danish', 'Dutch', 'English', 'Finnish', 'French', 'German', 'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Spanish', 'Swedish', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese'];

const find = (list, id) => list.find((x) => x.id === id) || list[0];

/** Clean a user prompt: one line of text, length-limited. */
export function cleanPrompt(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX);
}

/**
 * The image prompt for vector art. reference: { colors: ['#hex'], description }
 * from the selection (style reference).
 */
export function vectorPrompt({ prompt, contentType = 'subject', style = 'none', color = 'full', reference = null }) {
  const p = cleanPrompt(prompt);
  const ct = find(CONTENT_TYPES, contentType);
  const st = find(STYLES, style);
  const cm = find(COLOR_MODES, color);
  const parts = [p ? `${p}.` : 'Something pleasant and simple.', `${ct.phrase}.`];
  if (st.phrase) parts.push(`Style: ${st.phrase}.`);
  if (cm.phrase) parts.push(`Colors: ${cm.phrase}.`);
  if (reference?.description) parts.push(`Match this visual style: ${String(reference.description).slice(0, 400)}.`);
  if (reference?.colors?.length) parts.push(`Use this color palette: ${reference.colors.slice(0, 8).join(', ')}.`);
  parts.push('Vector graphic look: clean flat shapes with crisp edges and no photographic texture, no noise, no text, no watermark, no signature.');
  return parts.join(' ');
}

/** The chat prompt that asks for color palettes: JSON [{ name, colors }]. */
export function palettePrompt(prompt, { count = 4, colors = 5, current = [] } = {}) {
  return [
    `Create ${count} different color palettes inspired by: "${cleanPrompt(prompt)}".`,
    `Each palette has exactly ${colors} colors that work together, ordered from the most dominant to the least, with a range of light and dark values.`,
    current.length ? `They will recolor artwork whose current colors are ${current.slice(0, 12).join(', ')}; keep enough contrast between light and dark.` : '',
    'Give each palette a short evocative name of at most 3 words.',
    'Reply with only a JSON array like [{"name":"...","colors":["#rrggbb", ...]}] and no other text.',
  ].filter(Boolean).join('\n');
}

/** Normalize parsed palettes: [{ name, colors: ['#rrggbb'] }] with valid colors only. */
export function normalizePalettes(list, max = 8) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const raw = Array.isArray(p) ? p : p?.colors;
    if (!Array.isArray(raw)) continue;
    const colors = raw.map(normalizeHex).filter(Boolean);
    if (colors.length < 2) continue;
    out.push({ name: String((!Array.isArray(p) && p?.name) || `Palette ${out.length + 1}`).slice(0, 40), colors: [...new Set(colors)].slice(0, 12) });
    if (out.length >= max) break;
  }
  return out;
}

/** '#abc', 'ABCDEF', '#AbCdEf' -> '#aabbcc' / '#abcdef', or null. */
export function normalizeHex(v) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return `#${s.toLowerCase()}`;
}

/** Prompt to write new text for a frame. */
export function generateTextPrompt({ prompt, kind = 'paragraph', tone = 'friendly', context = '' }) {
  const k = find(TEXT_KINDS, kind);
  const t = find(TONES, tone);
  return [
    `Write ${k.ask} about: ${cleanPrompt(prompt)}`,
    `Tone: ${t.label.toLowerCase()}.`,
    context ? `It goes in a design that also says: """${String(context).slice(0, 800)}"""` : '',
    'Reply with only the text itself: no title, no quotes around it, no explanations, no markdown.',
  ].filter(Boolean).join('\n');
}

/** Prompt to rewrite text. Returns `count` alternatives as a JSON array of strings. */
export function rewritePrompt(text, { tone = 'friendly', length = 'same', instruction = '', count = 3 } = {}) {
  const t = find(TONES, tone);
  const len = { same: 'Keep about the same length.', shorter: 'Make it clearly shorter (about half as long) while keeping the key message.', longer: 'Make it longer and richer (about one and a half times as long).' }[length] || '';
  return [
    `Rewrite the text below in ${count} different ways.`,
    `Tone: ${t.label.toLowerCase()}.`,
    len,
    instruction ? `Also: ${cleanPrompt(instruction)}` : '',
    'Keep the same language as the original, keep line breaks where they separate items, and do not add facts that are not in the original.',
    'Reply with only a JSON array of strings.',
    `Text:\n"""${String(text).slice(0, 6000)}"""`,
  ].filter(Boolean).join('\n');
}

/** Prompt to proofread: JSON { text, changes: [{ from, to, why }] }. */
export function proofreadPrompt(text) {
  return [
    'Proofread the text below: fix spelling, grammar, punctuation and obvious typos only.',
    'Do not change the wording, tone, capitalization style or line breaks otherwise. Keep names and brand words as they are.',
    'Reply with only a JSON object {"text": "<corrected text>", "changes": [{"from": "<original words>", "to": "<corrected words>", "why": "<a few words>"}]}. Use an empty changes list when nothing needs fixing.',
    `Text:\n"""${String(text).slice(0, 6000)}"""`,
  ].join('\n');
}

/** Prompt to translate text, keeping line breaks. */
export function translatePrompt(text, language) {
  return [
    `Translate the text below into ${language}.`,
    'Keep line breaks exactly where they are, keep names, numbers and brand words, and keep the tone natural for printed design.',
    'Reply with only the translation, no notes, no quotes around it.',
    `Text:\n"""${String(text).slice(0, 6000)}"""`,
  ].join('\n');
}

/** Prompt to fit text to a frame: about `target` characters. */
export function fitPrompt(text, target, { lines = 0 } = {}) {
  const now = String(text).length;
  return [
    `Rewrite the text below so it is about ${target} characters long (it is now ${now}).`,
    target < now ? 'Shorten it, keeping the key message and the most important words.' : 'Expand it naturally, adding detail in the same voice without inventing specific facts.',
    lines ? `It must fit in about ${lines} lines.` : '',
    'Keep the same language and tone, keep paragraph breaks where they make sense.',
    'Reply with only the rewritten text, no notes, no quotes around it.',
    `Text:\n"""${String(text).slice(0, 6000)}"""`,
  ].filter(Boolean).join('\n');
}

/** Prompt that describes an image's visual style in a sentence (style reference). */
export const STYLE_DESCRIBE_PROMPT = 'Describe the visual style of this picture in one sentence of at most 35 words for an artist: technique, shapes, line quality, shading and color mood. Do not describe the subject.';

/** A short label for history and layer names: "a fox curled up asleep" -> "A fox curled up asleep". */
export function promptTitle(prompt, max = 48) {
  const p = cleanPrompt(prompt);
  if (!p) return 'Untitled';
  const t = p.length > max ? `${p.slice(0, max - 1).trimEnd()}…` : p;
  return t[0].toUpperCase() + t.slice(1);
}
