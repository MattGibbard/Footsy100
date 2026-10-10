// Data provider for the free (unofficial) Fantasy Premier League API.
// Everything the rest of the app needs goes through the DataProvider shape,
// so a paid source such as API-Football can be swapped in later.

import type { MatchStats, Position } from './pricing';

export interface ProviderTeam {
  id: number;
  name: string;
  short_name: string;
}

export interface ProviderPlayer {
  id: number;
  first_name: string;
  second_name: string;
  web_name: string;
  team_id: number;
  position: Position;
  status: string;
  start_price_pence: number;
}

export interface ProviderFixture {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  kickoff_time: string | null;
  started: boolean;
  finished: boolean;
  team_h_score: number | null;
  team_a_score: number | null;
}

export interface DataProvider {
  getSeasonName(): Promise<string>;
  getTeamsAndPlayers(): Promise<{ teams: ProviderTeam[]; players: ProviderPlayer[] }>;
  getFixtures(): Promise<ProviderFixture[]>;
  // Stat lines for every player who featured in the fixture, keyed by player id.
  getFixturePlayerStats(fixture: ProviderFixture): Promise<Map<number, MatchStats>>;
}

const BASE = 'https://fantasy.premierleague.com/api';
const POSITIONS: Record<number, Position> = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': 'Footsy100/0.1 (+https://github.com/MattGibbard/Footsy100)' },
  });
  if (!res.ok) throw new Error(`FPL ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

interface FplBootstrap {
  events: { id: number; deadline_time: string }[];
  teams: { id: number; name: string; short_name: string }[];
  elements: {
    id: number;
    first_name: string;
    second_name: string;
    web_name: string;
    team: number;
    element_type: number;
    status: string;
    now_cost: number;
  }[];
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

export function fplProvider(): DataProvider {
  let fixturesCache: FplFixture[] | null = null;
  const liveCache = new Map<number, FplLive>();

  const fixtures = async () => (fixturesCache ??= await getJson<FplFixture[]>('/fixtures/'));

  return {
    async getSeasonName() {
      const f = await fixtures();
      const first = f.map((x) => x.kickoff_time).filter(Boolean).sort()[0];
      const year = first ? new Date(first).getUTCFullYear() : new Date().getUTCFullYear();
      return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
    },

    async getTeamsAndPlayers() {
      const b = await getJson<FplBootstrap>('/bootstrap-static/');
      return {
        teams: b.teams.map((t) => ({ id: t.id, name: t.name, short_name: t.short_name })),
        players: b.elements
          .filter((e) => POSITIONS[e.element_type])
          .map((e) => ({
            id: e.id,
            first_name: e.first_name,
            second_name: e.second_name,
            web_name: e.web_name,
            team_id: e.team,
            position: POSITIONS[e.element_type],
            status: e.status,
            // FPL now_cost is in £0.1m units (55 = £5.5m); we list him at £5.50.
            start_price_pence: e.now_cost * 10,
          })),
      };
    },

    async getFixtures() {
      return (await fixtures()).map((f) => ({
        id: f.id,
        event: f.event,
        team_h: f.team_h,
        team_a: f.team_a,
        kickoff_time: f.kickoff_time,
        started: !!f.started,
        finished: f.finished,
        team_h_score: f.team_h_score,
        team_a_score: f.team_a_score,
      }));
    },

    async getFixturePlayerStats(pf) {
      const f = (await fixtures()).find((x) => x.id === pf.id);
      if (!f || f.event == null) throw new Error(`Fixture ${pf.id} not found in FPL data`);
      let live = liveCache.get(f.event);
      if (!live) liveCache.set(f.event, (live = await getJson<FplLive>(`/event/${f.event}/live/`)));
      return buildFixtureStats(f, live);
    },
  };
}
