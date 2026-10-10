import { describe, expect, it } from 'vitest';
import { buildFixtureStats, type FplFixture, type FplLive } from '../src/fpl';

// Shapes copied from the live FPL API (fixtures/ and event/{gw}/live/).
const fixture: FplFixture = {
  id: 1,
  event: 1,
  team_h: 1,
  team_a: 7,
  kickoff_time: '2026-08-21T19:00:00Z',
  started: true,
  finished: true,
  team_h_score: 3,
  team_a_score: 0,
  stats: [
    { identifier: 'goals_scored', a: [], h: [{ value: 1, element: 12 }, { value: 2, element: 15 }] },
    { identifier: 'assists', a: [], h: [{ value: 1, element: 10 }] },
    { identifier: 'yellow_cards', a: [{ value: 1, element: 575 }], h: [] },
    { identifier: 'saves', a: [{ value: 2, element: 110 }], h: [{ value: 1, element: 1 }] },
    { identifier: 'bonus', a: [], h: [{ value: 3, element: 15 }] },
    { identifier: 'bps', a: [{ value: 9, element: 575 }], h: [{ value: 40, element: 15 }, { value: 24, element: 1 }] },
  ],
};

const live: FplLive = {
  elements: [
    { id: 1, explain: [{ fixture: 1, stats: [{ identifier: 'minutes', value: 90 }, { identifier: 'clean_sheets', value: 1 }] }] },
    { id: 15, explain: [{ fixture: 1, stats: [{ identifier: 'minutes', value: 78 }] }] },
    { id: 575, explain: [{ fixture: 1, stats: [{ identifier: 'minutes', value: 90 }, { identifier: 'goals_conceded', value: 3 }] }] },
    // Double gameweek: only the matching fixture's explain block should count.
    { id: 10, explain: [{ fixture: 99, stats: [{ identifier: 'minutes', value: 90 }] }, { fixture: 1, stats: [{ identifier: 'minutes', value: 30 }] }] },
    { id: 2, explain: [{ fixture: 1, stats: [{ identifier: 'minutes', value: 0 }] }] },
  ],
};

describe('buildFixtureStats', () => {
  const stats = buildFixtureStats(fixture, live);

  it('merges minutes and clean sheets with fixture events', () => {
    expect(stats.get(1)).toMatchObject({ minutes: 90, clean_sheet: 1, saves: 1, bps: 24 });
    expect(stats.get(15)).toMatchObject({ minutes: 78, goals: 2, bonus: 3, bps: 40 });
    expect(stats.get(575)).toMatchObject({ minutes: 90, goals_conceded: 3, yellow_cards: 1 });
  });

  it('uses the right fixture in a double gameweek', () => {
    expect(stats.get(10)).toMatchObject({ minutes: 30, assists: 1 });
  });

  it('drops players who did not play', () => {
    expect(stats.has(2)).toBe(false);
  });
});
