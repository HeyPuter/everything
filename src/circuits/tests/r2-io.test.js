// Round 2 review: manufacturing outputs, import, the project format and storage.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { exportGerbers } from '../src/io/gerber.js';
import { importKicad } from '../src/io/kicad/index.js';
import { UserLibrary } from '../src/app/user-library.js';
import { setPuterForTests } from '../src/app/puter.js';
import { recordVersion } from '../src/app/history.js';
import { parseProject } from '../src/model/project.js';
import { mm } from '../src/core/units.js';
import { defaultRules } from '../src/model/schema.js';

const emptyBoard = (objects) => ({
  id: 'b1',
  kind: 'pcb',
  name: 'Board.pcb',
  board: {
    outline: [0, 0, mm(30), 0, mm(30), mm(20), 0, mm(20)],
    origin: { x: 0, y: 0 },
    copper: 2,
  },
  rules: defaultRules(),
  nets: {},
  objects,
});
const gerber = (doc, ext, lib = {}) =>
  exportGerbers(doc, lib, {}).find((f) => f.name.endsWith(`.${ext}`))?.content;
/** The drawing commands of a Gerber file, without the header and aperture list. */
const body = (text) =>
  text.split('\n').filter((l) => /^(X|G0[123]|G3[67]|D\d)/.test(l) && !/^G0[14]\*$|^G75/.test(l));

describe('Gerber drawings on paste, mask and mechanical layers', () => {
  const square = { x1: mm(1), y1: mm(1), x2: mm(3), y2: mm(2) };
  const region = [
    'G36*',
    'X1000000Y1000000D02*',
    'X3000000Y1000000D01*',
    'X3000000Y2000000D01*',
    'X1000000Y2000000D01*',
    'X1000000Y1000000D01*',
    'G37*',
  ];

  it('writes shapes drawn on a paste layer into the stencil file', () => {
    const doc = emptyBoard([
      { id: 'f', t: 'fill', layer: 'topPaste', ...square },
      { id: 'r', t: 'region', layer: 'bottomPaste', pts: [0, 0, mm(1), 0, mm(1), mm(1)] },
      { id: 't', t: 'track', layer: 'topPaste', x1: 0, y1: 0, x2: mm(5), y2: 0, w: mm(0.3) },
      {
        id: 'a',
        t: 'arc',
        layer: 'topPaste',
        cx: 0,
        cy: 0,
        r: mm(2),
        a0: 0,
        sweep: 90,
        w: mm(0.3),
      },
    ]);
    const top = gerber(doc, 'GTP');
    expect(body(top)).toEqual(expect.arrayContaining(region));
    expect(top).toContain('%ADD10C,0.3*%');
    expect(top).toContain('X0Y0D02*\nX5000000Y0D01*');
    expect(top).toContain('G03X0Y2000000I-2000000J0D01*');
    expect(top).not.toContain('X1000000Y0D01*');
    expect(body(gerber(doc, 'GBP'))).toEqual([
      'G36*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y0D01*',
      'G37*',
    ]);
  });

  it('writes fills drawn on a mechanical layer', () => {
    const files = exportGerbers(
      emptyBoard([{ id: 'f', t: 'fill', layer: 'mech1', ...square }]),
      {},
      {},
    );
    const mech = files.find((f) => f.layer === 'mech1');
    expect(mech).toBeTruthy();
    expect(body(mech.content)).toEqual(region);
  });

  it('writes text placed on a solder mask layer as mask openings', () => {
    const text = { id: 'x', t: 'text', x: mm(5), y: mm(5), text: 'I', h: mm(2), w: mm(0.25) };
    const mask = gerber(emptyBoard([{ ...text, layer: 'topSolder' }]), 'GTS');
    const silk = gerber(emptyBoard([{ ...text, layer: 'topOverlay' }]), 'GTO');
    expect(body(silk).length).toBeGreaterThan(1);
    expect(body(mask)).toEqual(body(silk));
    expect(body(gerber(emptyBoard([{ ...text, layer: 'topSolder' }]), 'GBS'))).toEqual([]);
  });
});

describe('KiCad symbols edited in the schematic', () => {
  const F = '(effects (font (size 1.27 1.27)))';
  const sym = (name, sub, pinX) => `(symbol "${name}"
    (property "Reference" "R" (at 2 0 90) ${F}) (property "Value" "R" (at 0 0 90) ${F})
    (symbol "${sub}_1_1"
      (pin passive line (at ${pinX} 3.81 270) (length 1.27) (name "~" ${F}) (number "1" ${F}))))`;
  const part = (
    ref,
    x,
    libName,
  ) => `(symbol ${libName ? `(lib_name "${libName}") ` : ''}(lib_id "Device:R")
    (at ${x} 50.8 0) (unit 1) (uuid "${ref}")
    (property "Reference" "${ref}" (at 0 0 0) ${F}) (property "Value" "10k" (at 0 0 0) ${F}))`;

  it('uses the symbol variant an instance names with lib_name', async () => {
    // KiCad keeps a symbol that differs from its library under its own name
    // ("R_1") and points the instance at it with lib_name.
    const text = `(kicad_sch (version 20231120) (generator "eeschema") (paper "A4")
      (lib_symbols ${sym('Device:R', 'R', 0)} ${sym('R_1', 'R_1', 2.54)})
      ${part('R1', 100.33)} ${part('R2', 120.65, 'R_1')})`;
    const { project, warnings } = await importKicad([{ name: 'a.kicad_sch', text }]);
    const parts = project.documents[0].objects.filter((o) => o.t === 'part');
    const pinX = (ref) =>
      project.library[parts.find((p) => p.designator === ref).comp].symbol.pins[0].x;
    expect(parts.map((p) => p.designator)).toEqual(['R1', 'R2']);
    expect(pinX('R1')).toBe(0);
    expect(pinX('R2')).toBe(mm(2.54));
    expect(warnings).toEqual([]);
  });

  it('imports an instance whose library entry only exists under its lib_name', async () => {
    const text = `(kicad_sch (version 20231120) (generator "eeschema") (paper "A4")
      (lib_symbols ${sym('R_1', 'R_1', 2.54)})
      ${part('R2', 120.65, 'R_1')})`;
    const { project, warnings } = await importKicad([{ name: 'a.kicad_sch', text }]);
    expect(project.documents[0].objects.filter((o) => o.t === 'part').length).toBe(1);
    expect(warnings).toEqual([]);
  });
});

describe('My library when it cannot be read', () => {
  const PATH = 'Libraries/My components.circuitslib';
  const def = (id) => ({ id, name: id, symbol: { pins: [], graphics: [] }, footprint: null });
  const stored = JSON.stringify({
    format: 'circuits-library',
    version: 1,
    components: [def('old-1'), def('old-2')],
  });

  /** A cloud whose reads fail (as when offline) while `down` is set. */
  function flakyCloud() {
    const files = new Map([[PATH, stored]]);
    const state = { down: true, files };
    const fs = {
      async read(path) {
        if (state.down) throw new Error('Failed to fetch');
        if (!files.has(path))
          throw Object.assign(new Error('subject_does_not_exist'), {
            code: 'subject_does_not_exist',
          });
        return new Blob([files.get(path)]);
      },
      async write(path, text) {
        files.set(path, text);
        return { path };
      },
    };
    setPuterForTests({ env: 'web', auth: { isSignedIn: () => true }, fs });
    return state;
  }
  const idsIn = (text) =>
    JSON.parse(text)
      .components.map((c) => c.id)
      .sort();

  afterEach(() => {
    setPuterForTests(null);
    vi.restoreAllMocks();
  });

  it('keeps the stored components when one is added after a failed load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = flakyCloud();
    const lib = new UserLibrary();
    await lib.load();
    expect(lib.all()).toEqual([]);
    cloud.down = false;
    await lib.put(def('new'));
    expect(idsIn(cloud.files.get(PATH))).toEqual(['new', 'old-1', 'old-2']);
    expect(
      lib
        .all()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['new', 'old-1', 'old-2']);
  });

  it('does not overwrite the stored library while it still cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cloud = flakyCloud();
    const lib = new UserLibrary();
    await lib.load();
    await lib.put(def('new'));
    expect(cloud.files.get(PATH)).toBe(stored);
    // Once storage answers again the next change saves everything.
    cloud.down = false;
    await lib.put(def('newer'));
    expect(idsIn(cloud.files.get(PATH))).toEqual(['new', 'newer', 'old-1', 'old-2']);
  });

  it('still creates the library when there is none yet', async () => {
    const cloud = flakyCloud();
    cloud.down = false;
    cloud.files.clear();
    const lib = new UserLibrary();
    await lib.load();
    await lib.put(def('first'));
    expect(idsIn(cloud.files.get(PATH))).toEqual(['first']);
  });
});

describe('project ids from files', () => {
  const file = (id) =>
    JSON.stringify({ format: 'circuits-project', version: 1, id, name: 'P', documents: [] });

  /** In-memory cloud that resolves '..' in paths the way a real file system does. */
  function pathCloud() {
    const files = new Map();
    const norm = (p) => {
      const out = [];
      for (const part of p.split('/')) {
        if (part === '..') out.pop();
        else if (part && part !== '.') out.push(part);
      }
      return out.join('/');
    };
    const missing = () =>
      Object.assign(new Error('subject_does_not_exist'), { code: 'subject_does_not_exist' });
    const fs = {
      async write(path, text) {
        files.set(norm(path), text);
        return { path: norm(path) };
      },
      async readdir(dir) {
        const d = `${norm(dir)}/`;
        const out = [];
        for (const p of files.keys()) {
          if (p.startsWith(d) && !p.slice(d.length).includes('/'))
            out.push({ name: p.slice(d.length), path: p, modified: 1 });
        }
        if (!out.length) throw missing();
        return out;
      },
      async delete(path) {
        files.delete(norm(path));
      },
    };
    setPuterForTests({ env: 'web', auth: { isSignedIn: () => true }, fs });
    return files;
  }

  afterEach(() => setPuterForTests(null));

  it('keeps versions of a project inside its own version folder', async () => {
    const files = pathCloud();
    for (let i = 0; i < 45; i++) files.set(`Projects/Mine ${i}.circuits`, '{}');
    // A file from someone else can carry any id; it names the version folder.
    const p = parseProject(file('..'));
    await recordVersion({ type: 'cloud', path: 'Projects/P.circuits' }, p.id, '{}');
    const projects = [...files.keys()].filter((k) => /^Projects\/[^/]+\.circuits$/.test(k));
    expect(projects.length).toBe(45);
    expect(
      [...files.keys()].filter((k) => k.startsWith(`Projects/.versions/${p.id}/`)).length,
    ).toBe(1);
  });

  it('replaces ids that are not plain names and keeps the ones the app makes', () => {
    for (const id of ['..', '../../x', 'a/b', 'a\\b', '', 7, null, { a: 1 }, 'x'.repeat(500)]) {
      expect(parseProject(file(id)).id).toMatch(/^[\w-]{1,128}$/);
    }
    for (const id of ['pmh1x2abc9zk3', 'pmh1x2abc9zk3-mh1x2b00', 'p_1'])
      expect(parseProject(file(id)).id).toBe(id);
  });
});
