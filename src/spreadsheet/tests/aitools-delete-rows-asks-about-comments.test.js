import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { describeCall } from '../src/core/aitools.js';
import { addComment } from '../src/core/comments.js';

// Deleting rows or columns asked first when they held data or notes, but not when they held only a comment thread:
// the thread, the user's and their colleagues' writing, went without a question under the default approval mode.
describe('the assistant deleting rows or columns', () => {
  it('asks first when they hold a comment thread', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const env = { sheetId: () => id };
    addComment(wb, id, 7, 2, 'Please check this row', 'Ann');
    const rows = describeCall(wb, 'delete_rows', { start_row: 8 }, env);
    expect(rows).toMatchObject({ destructive: true, detail: 'Removes 1 comment thread.' });
    expect(describeCall(wb, 'delete_columns', { start_column: 'C' }, env).destructive).toBe(true);
    expect(describeCall(wb, 'delete_rows', { start_row: 9 }, env).destructive).toBe(false);
  });
});
