// Simplified Chinese: every catalog in src/locales/zh-Hans, as one chunk loaded when the language is chosen.
export default import.meta.glob('../../locales/zh-Hans/*.json', { eager: true, import: 'default' });
