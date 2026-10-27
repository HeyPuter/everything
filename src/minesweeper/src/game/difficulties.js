/**
 * Classic Windows Minesweeper board sizes (DOCUMENTED public rules).
 * Custom boards are out of scope for this app.
 */

/** @typedef {'beginner' | 'intermediate' | 'expert'} DifficultyId */

/**
 * @typedef {object} Difficulty
 * @property {DifficultyId} id
 * @property {string} label
 * @property {number} rows
 * @property {number} cols
 * @property {number} mines
 */

/** @type {Record<DifficultyId, Difficulty>} */
export const DIFFICULTIES = {
  beginner: { id: 'beginner', label: 'Beginner', rows: 9, cols: 9, mines: 10 },
  intermediate: { id: 'intermediate', label: 'Intermediate', rows: 16, cols: 16, mines: 40 },
  expert: { id: 'expert', label: 'Expert', rows: 16, cols: 30, mines: 99 },
};

/** @type {DifficultyId[]} */
export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES);

/** @param {string} id */
export function isDifficulty(id) {
  return Object.prototype.hasOwnProperty.call(DIFFICULTIES, id);
}

/** @param {string} id @returns {Difficulty} */
export function getDifficulty(id) {
  return isDifficulty(id) ? DIFFICULTIES[id] : DIFFICULTIES.beginner;
}
