import { loadLocalFace } from '../../engine/local-font-probe.js';

/** Resolve unavailable Hanword fonts locally before the editor measures text. */
const sans = ['Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', 'Noto Sans KR', 'Arial', 'Liberation Sans', 'DejaVu Sans'];
const serif = ['Batang', 'AppleMyungjo', 'Noto Serif CJK KR', 'Noto Serif KR', 'Times New Roman', 'Liberation Serif'];
const mono = ['Consolas', 'Menlo', 'Liberation Mono', 'Courier New'];
const category = (name) => /바탕|명조|궁서|batang|myeongjo|gungsuh|serif|times/i.test(name) ? serif : /mono|courier|consolas/i.test(name) ? mono : sans;
// Local font APIs may expose only the English or only the Korean family name.
// Try equivalent names before replacing a face with a different design.
const families = [['맑은 고딕', 'Malgun Gothic'], ['바탕', 'Batang'], ['바탕체', 'BatangChe'], ['돋움', 'Dotum'], ['돋움체', 'DotumChe'], ['굴림', 'Gulim'], ['굴림체', 'GulimChe'], ['궁서', 'Gungsuh'], ['궁서체', 'GungsuhChe'], ['함초롬바탕', 'HCR Batang'], ['함초롬돋움', 'HCR Dotum']];
const aliases = (name) => families.find((names) => names.some((n) => n.toLowerCase() === name.toLowerCase())) || [];

export async function prepareHanwordFonts(model) {
  if (typeof FontFace === 'undefined') return;
  const available = new Map();
  const local = (name) => {
    if (!available.has(name)) available.set(name, Promise.resolve().then(() => loadLocalFace('Documents font probe', `local(${JSON.stringify(name)})`)).then(() => true, () => false));
    return available.get(name);
  };
  const names = [...new Set(model.chars.flatMap((c) => [c?.font, c?.eastAsia]).filter(Boolean))];
  const replacements = new Map();
  // Probes only use local() sources, never URLs. Bound the work for documents
  // containing unusually large font tables and preserve unexamined families.
  await Promise.all(names.slice(0, 256).map(async (name) => {
    if (await local(name)) return;
    const declared = model.fontFallbacks?.get(name) || [];
    const candidates = [...aliases(name), ...declared.flatMap((font) => [font, ...aliases(font)]), ...category(name).flatMap((font) => [font, ...aliases(font)])];
    for (const candidate of new Set(candidates)) if (await local(candidate)) { replacements.set(name, candidate); break; }
  }));
  for (const c of model.chars) for (const key of ['font', 'eastAsia']) if (replacements.has(c?.[key])) c[key] = replacements.get(c[key]);
  if (replacements.size) {
    const labels = [...replacements].map(([from, to]) => `${from} → ${to}`);
    model.warnings.add(`Unavailable fonts were replaced with installed fonts in the editable copy: ${labels.slice(0, 8).join('; ')}${labels.length > 8 ? `; and ${labels.length - 8} more` : ''}.`);
  }
}
