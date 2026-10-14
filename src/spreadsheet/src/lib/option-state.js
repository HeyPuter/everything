/**
 * The few app options that low-level modules act on (lib/puter.js for AI, lib/doc.js for AutoSave and the
 * recovery copy), as plain values with no imports, so those modules need not know where options come from.
 * lib/app-options.js keeps them up to date.
 */
export const optionState = {
  aiFeatures: true, // false: AI features are hidden and nothing is sent to an AI service
  autoSave: true, // AutoSave's setting where the device never chose
  draftDelay: 1, // seconds of quiet before unsaved edits are copied into this browser
};
