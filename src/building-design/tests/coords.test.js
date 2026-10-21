import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { upgradeDoc } from '../src/core/template.js';
import { coordinatesAt, elevationFrom, basePoint } from '../src/core/coords.js';

describe('project coordinates', () => {
  it('every opened project has a base point and a survey point with fixed ids', () => {
    const { doc } = project();
    upgradeDoc(doc);
    expect(basePoint(doc, 'project').id).toBe('base-point');
    expect(basePoint(doc, 'survey').id).toBe('survey-point');
    expect(doc.modified).toBe(false);
  });

  it('report site coordinates from the survey point, turned to true north', () => {
    const { doc } = project();
    upgradeDoc(doc);
    doc.transact('s', () => doc.update('survey-point', { at: [1000, 2000], n: 500000, e: 200000, elevation: 35000 }));
    expect(coordinatesAt(doc, [1000, 5000])).toEqual({ n: 503000, e: 200000 });
    // True north 90 degrees counterclockwise from up: the model's -X is north.
    doc.transact('north', () => doc.update('project', { trueNorth: 90 }));
    const c = coordinatesAt(doc, [-2000, 2000]);
    expect(c.n).toBeCloseTo(503000, 6);
    expect(c.e).toBeCloseTo(200000, 6);
    expect(elevationFrom(doc, 3000, 'survey')).toBe(38000);
  });

  it('report project coordinates and elevations from the project base point', () => {
    const { doc } = project();
    upgradeDoc(doc);
    doc.transact('b', () => doc.update('base-point', { at: [100, 200], elevation: 450 }));
    expect(coordinatesAt(doc, [1100, 1200], 'project')).toEqual({ n: 1000, e: 1000 });
    expect(elevationFrom(doc, 450)).toBe(0);
  });
});
