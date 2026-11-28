import { describe, expect, it } from 'vitest';
import { runMacro } from '../src/engine/interpreter.js';
import { createWorksheet } from '../src/engine/worksheet.js';

function host() {
  return { worksheet: createWorksheet(), messages: [] };
}

describe('VBA-inspired interpreter', () => {
  it('runs a Sub that writes Range values and MsgBox', () => {
    const h = host();
    runMacro(
      `
Sub Demo()
  Range("A1").Value = 10
  Range("B1").Value = Range("A1").Value * 2
  MsgBox "done"
End Sub
`,
      h,
    );
    expect(h.worksheet.get('A1')).toBe(10);
    expect(h.worksheet.get('B1')).toBe(20);
    expect(h.messages).toEqual(['done']);
  });

  it('supports For/Next writing sequential cells via Let', () => {
    const h = host();
    runMacro(
      `
Sub LoopDemo()
  Dim total
  total = 0
  Dim i
  For i = 1 To 4
    total = total + i
  Next
  Range("A1").Value = total
End Sub
`,
      h,
    );
    expect(h.worksheet.get('A1')).toBe(10);
  });

  it('supports If/Then/Else', () => {
    const h = host();
    runMacro(
      `
Sub Branch()
  Range("A1").Value = 3
  If Range("A1").Value > 2 Then
    Range("B1").Value = "yes"
  Else
    Range("B1").Value = "no"
  End If
End Sub
`,
      h,
    );
    expect(h.worksheet.get('B1')).toBe('yes');
  });

  it('string concatenation with &', () => {
    const h = host();
    runMacro(
      `
Sub S()
  Range("A1").Value = "Hello" & " " & "World"
End Sub
`,
      h,
    );
    expect(h.worksheet.get('A1')).toBe('Hello World');
  });
});
