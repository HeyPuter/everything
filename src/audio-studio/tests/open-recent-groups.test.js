import { expect, it } from 'vitest';
import { recentGroups } from '../src/features/io.js';

it('lists sessions before audio files and names the folder of files that share a name', () => {
  const list = [
    { name: 'Take.wav', path: '/u/A/Take.wav' },
    { name: 'Show.asesx', path: '/u/Show.asesx' },
    { name: 'Take.wav', path: '/u/B/Take.wav' },
    { name: 'Intro.mp3', path: '/u/Intro.mp3' },
  ];
  const groups = recentGroups(list);
  expect(groups.map((g) => g.map((r) => r.label))).toEqual([['Show.asesx'], ['Take.wav (A)', 'Take.wav (B)', 'Intro.mp3']]);
  expect(recentGroups([{ name: 'a.wav', path: '/u/a.wav' }])).toHaveLength(1);
});
