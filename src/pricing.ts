// Price engine: turns one player's stat line from one match into a price move.
// All weights are percentages expressed in basis points (100 bp = 1%), so they
// are easy to tune in one place.
//
// A match is judged against what's expected of a player at his price, so an
// ordinary game leaves his price where it is and only beating (or missing)
// expectations moves it. That stops prices creeping up just by holding cards.

export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD';

export interface MatchStats {
  minutes: number;
  goals: number;
  assists: number;
  clean_sheet: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;
  defensive_contribution: number;
}

export const WEIGHTS = {
  didNotPlay: -100, // team played but he didn't
  goal: { GKP: 1000, DEF: 1000, MID: 800, FWD: 600 } as Record<Position, number>,
  assist: 500,
  cleanSheet: { GKP: 400, DEF: 400, MID: 100, FWD: 0 } as Record<Position, number>,
  per2GoalsConceded: { GKP: -100, DEF: -100, MID: 0, FWD: 0 } as Record<Position, number>,
  per3Saves: 100,
  penaltySaved: 600,
  penaltyMissed: -500,
  yellowCard: -200,
  redCard: -800,
  ownGoal: -500,
  perBonusPoint: 100,
  // FPL's defensive contribution threshold (CBIT/CBIRT) is 10 for defenders, 12 otherwise
  defensiveContribution: 200,
  // Demand: every 10 cards net bought (minus sold) since the last match nudges +0.1%
  demandPer10Cards: 10,
  demandCap: 300,
  // What a player is expected to earn from his stats over 90 minutes: base + perPound
  // for every £1 of his price, scaled down for fewer minutes. Fitted to 2025/26 FPL
  // match data with scripts/simulate-season.mjs.
  expected: {
    GKP: { base: -82, perPound: 44 },
    DEF: { base: -240, perPound: 88 },
    MID: { base: -62, perPound: 55 },
    FWD: { base: 13, perPound: 45 },
  } as Record<Position, { base: number; perPound: number }>,
  // Safety net: each match also subtracts the season's average beat-or-miss so far
  // (from everyone who has played), so the market as a whole stays flat.
  marketCap: 300,
  maxRise: 4000,
  maxFall: -2500,
};

export const MIN_PRICE_PENCE = 10;

export interface PriceChange {
  changeBp: number;
  breakdown: Record<string, number>;
  // Stats minus expectation, before demand and the market adjustment (null if he didn't play).
  vsExpectedBp: number | null;
}

export interface MatchContext {
  netCards?: number; // cards net bought since his last match
  pricePence?: number; // his price going into the match
  marketBp?: number; // the season's average vs-expected so far, from marketAdjustment()
}

export function defensiveThreshold(position: Position): number {
  return position === 'DEF' ? 10 : 12;
}

export function expectedBp(position: Position, pricePence: number, minutes: number): number {
  const e = WEIGHTS.expected[position];
  return Math.round(((e.base + (e.perPound * pricePence) / 100) * Math.min(minutes, 90)) / 90);
}

// Turns the season's average vs-expected so far into this match's correction.
export function marketAdjustment(averageVsExpectedBp: number | null): number {
  return clamp(-Math.round(averageVsExpectedBp ?? 0) || 0, -WEIGHTS.marketCap, WEIGHTS.marketCap);
}

export function scoreMatch(position: Position, s: MatchStats | null, ctx: MatchContext = {}): PriceChange {
  const { netCards = 0, pricePence = 0, marketBp = 0 } = ctx;
  const b: Record<string, number> = {};
  const add = (k: string, v: number) => {
    if (v !== 0) b[k] = (b[k] ?? 0) + v;
  };

  if (!s || s.minutes <= 0) {
    add('did_not_play', WEIGHTS.didNotPlay);
  } else {
    add('goals', s.goals * WEIGHTS.goal[position]);
    add('assists', s.assists * WEIGHTS.assist);
    if (s.clean_sheet && s.minutes >= 60) add('clean_sheet', WEIGHTS.cleanSheet[position]);
    add('goals_conceded', Math.floor(s.goals_conceded / 2) * WEIGHTS.per2GoalsConceded[position]);
    if (position === 'GKP') add('saves', Math.floor(s.saves / 3) * WEIGHTS.per3Saves);
    add('penalties_saved', s.penalties_saved * WEIGHTS.penaltySaved);
    add('penalties_missed', s.penalties_missed * WEIGHTS.penaltyMissed);
    add('yellow_cards', s.yellow_cards * WEIGHTS.yellowCard);
    add('red_cards', s.red_cards * WEIGHTS.redCard);
    add('own_goals', s.own_goals * WEIGHTS.ownGoal);
    add('bonus', s.bonus * WEIGHTS.perBonusPoint);
    if (position !== 'GKP' && s.defensive_contribution >= defensiveThreshold(position)) {
      add('defensive_contribution', WEIGHTS.defensiveContribution);
    }
  }

  let vsExpectedBp: number | null = null;
  if (s && s.minutes > 0) {
    add('expected', -expectedBp(position, pricePence, s.minutes));
    vsExpectedBp = Object.values(b).reduce((a, v) => a + v, 0);
    add('market', marketBp);
  }

  const demand = Math.trunc((netCards / 10) * WEIGHTS.demandPer10Cards);
  add('demand', clamp(demand, -WEIGHTS.demandCap, WEIGHTS.demandCap));

  const total = Object.values(b).reduce((a, v) => a + v, 0);
  return { changeBp: clamp(total, WEIGHTS.maxFall, WEIGHTS.maxRise), breakdown: b, vsExpectedBp };
}

export function applyChange(pricePence: number, changeBp: number): number {
  return Math.max(MIN_PRICE_PENCE, Math.round((pricePence * (10000 + changeBp)) / 10000));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
