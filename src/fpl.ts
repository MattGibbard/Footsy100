// Data provider for the free (unofficial) Fantasy Premier League API.
// Everything the rest of the app needs goes through the DataProvider shape,
// so a paid source such as API-Football can be swapped in later.

import type { MatchStats } from './pricing';

// The provider hands back raw JSON text in FPL's shape and the database parses
// it (json_each), because parsing FPL's ~2MB player file in the Worker blows the
// free plan's 10ms CPU budget. Another source can be adapted by emitting the
// same shape.
export interface DataProvider {
  bootstrapText(): Promise<string>; // FPL /bootstrap-static/
  fixturesText(): Promise<string>; // FPL /fixtures/
  gameweekFixturesText(event: number): Promise<string>; // FPL /fixtures/?event=N (small)
  liveText(event: number): Promise<string>; // FPL /event/N/live/
}

const BASE = 'https://fantasy.premierleague.com/api';

async function get(path: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': 'Footsy100/0.1 (+https://github.com/MattGibbard/Footsy100)' },
  });
  if (!res.ok) throw new Error(`FPL ${path} returned ${res.status}`);
  return res;
}

interface FplFixtureStat {
  identifier: string;
  a: { value: number; element: number }[];
  h: { value: number; element: number }[];
}

export interface FplFixture {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  kickoff_time: string | null;
  started: boolean | null;
  finished: boolean;
  team_h_score: number | null;
  team_a_score: number | null;
  stats: FplFixtureStat[];
}

export interface FplLive {
  elements: {
    id: number;
    explain: { fixture: number; stats: { identifier: string; value: number }[] }[];
  }[];
}

export function emptyStats(): MatchStats {
  return {
    minutes: 0,
    goals: 0,
    assists: 0,
    clean_sheet: 0,
    goals_conceded: 0,
    own_goals: 0,
    penalties_saved: 0,
    penalties_missed: 0,
    yellow_cards: 0,
    red_cards: 0,
    saves: 0,
    bonus: 0,
    bps: 0,
    defensive_contribution: 0,
  };
}

// FPL fixture stat identifiers -> our MatchStats keys
const FIXTURE_STAT_KEYS: Record<string, keyof MatchStats> = {
  goals_scored: 'goals',
  assists: 'assists',
  own_goals: 'own_goals',
  penalties_saved: 'penalties_saved',
  penalties_missed: 'penalties_missed',
  yellow_cards: 'yellow_cards',
  red_cards: 'red_cards',
  saves: 'saves',
  bonus: 'bonus',
  bps: 'bps',
  defensive_contribution: 'defensive_contribution',
};

// Combine the per-fixture event stats with the gameweek "live" explain block
// (which carries minutes, clean sheets and goals conceded per fixture).
export function buildFixtureStats(fixture: FplFixture, live: FplLive): Map<number, MatchStats> {
  const out = new Map<number, MatchStats>();
  const get = (id: number) => {
    let s = out.get(id);
    if (!s) out.set(id, (s = emptyStats()));
    return s;
  };

  for (const el of live.elements) {
    for (const ex of el.explain) {
      if (ex.fixture !== fixture.id) continue;
      for (const st of ex.stats) {
        if (st.identifier === 'minutes') get(el.id).minutes = st.value;
        else if (st.identifier === 'clean_sheets') get(el.id).clean_sheet = st.value;
        else if (st.identifier === 'goals_conceded') get(el.id).goals_conceded = st.value;
      }
    }
  }

  for (const stat of fixture.stats) {
    const key = FIXTURE_STAT_KEYS[stat.identifier];
    if (!key) continue;
    for (const row of [...stat.h, ...stat.a]) get(row.element)[key] = row.value;
  }

  // Players who appear only through BPS etc. but with no minutes recorded did not play.
  for (const [id, s] of out) if (s.minutes === 0 && s.bps === 0 && s.goals === 0) out.delete(id);
  return out;
}

// Pulls the array stored under `key` out of a JSON object's text without parsing
// it. The scan only walks the array itself; pass `isLastKey` for an array that
// closes the document (FPL's `elements`) to skip even that.
export function sliceArray(text: string, key: string, isLastKey = false): string {
  const marker = `"${key}":[`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`"${key}" not found in provider data`);
  const from = start + marker.length - 1;
  if (isLastKey) {
    const end = text.lastIndexOf(']');
    if (end < from || text.slice(end + 1).trim() !== '}') throw new Error(`"${key}" is not the last key`);
    return text.slice(from, end + 1);
  }
  // Walk to the matching bracket, skipping strings.
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash escape
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) depth++;
    else if (c === 93 || c === 125) {
      if (--depth === 0) return text.slice(from, i + 1);
    }
  }
  throw new Error(`"${key}" array is not terminated`);
}

// Splits a JSON array's text into smaller JSON arrays (D1 caps a bound value at
// 2MB). Objects are split at "},{"<first key>": boundaries, which only occur
// between top-level items because every item starts with the same key.
export function chunkArray(arrayText: string, maxBytes = 500_000): string[] {
  const body = arrayText.trim().slice(1, -1);
  if (!body) return [];
  const firstKey = body.match(/^\{"([^"]+)":/)?.[1];
  if (!firstKey || body.length <= maxBytes) return [`[${body}]`];
  const boundary = `},{"${firstKey}":`;
  const out: string[] = [];
  let rest = body;
  while (rest.length > maxBytes) {
    let cut = rest.lastIndexOf(boundary, maxBytes);
    if (cut <= 0) cut = rest.indexOf(boundary, maxBytes);
    if (cut < 0) break;
    out.push(`[${rest.slice(0, cut + 1)}]`);
    rest = rest.slice(cut + 2);
  }
  out.push(`[${rest}]`);
  return out;
}

export function fplProvider(): DataProvider {
  const text = async (path: string) => (await get(path)).text();
  return {
    bootstrapText: () => text('/bootstrap-static/'),
    fixturesText: () => text('/fixtures/'),
    gameweekFixturesText: (event) => text(`/fixtures/?event=${event}`),
    liveText: (event) => text(`/event/${event}/live/`),
  };
}
