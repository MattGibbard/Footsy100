import { describe, expect, it } from 'vitest';
import { emptyStats } from '../src/fpl';
import { saleProceeds, valueOf } from '../src/money';
import { MIN_PRICE_PENCE, applyChange, scoreMatch } from '../src/pricing';

const line = (o: Partial<ReturnType<typeof emptyStats>>) => ({ ...emptyStats(), ...o });

describe('scoreMatch', () => {
  it('rewards a forward who scores and assists', () => {
    const r = scoreMatch('FWD', line({ minutes: 90, goals: 2, assists: 1, bonus: 3 }));
    // 1% appearance + 2x6% goals + 5% assist + 3% bonus
    expect(r.changeBp).toBe(100 + 1200 + 500 + 300);
  });

  it('rewards a defender clean sheet but not a sub cameo clean sheet', () => {
    expect(scoreMatch('DEF', line({ minutes: 90, clean_sheet: 1 })).changeBp).toBe(500);
    expect(scoreMatch('DEF', line({ minutes: 20, clean_sheet: 1 })).changeBp).toBe(50);
  });

  it('punishes cards, own goals and conceding', () => {
    const r = scoreMatch('GKP', line({ minutes: 90, red_cards: 1, own_goals: 1, goals_conceded: 4, saves: 7 }));
    expect(r.breakdown).toMatchObject({ red_cards: -800, own_goals: -500, goals_conceded: -200, saves: 200 });
  });

  it('drifts down when the player does not feature', () => {
    expect(scoreMatch('MID', null).changeBp).toBe(-100);
    expect(scoreMatch('MID', line({ minutes: 0 })).changeBp).toBe(-100);
  });

  it('applies a capped demand nudge', () => {
    expect(scoreMatch('MID', null, 50).breakdown.demand).toBe(50); // 50 cards net bought -> +0.5%
    expect(scoreMatch('MID', null, 10_000).breakdown.demand).toBe(300);
    expect(scoreMatch('MID', null, -10_000).breakdown.demand).toBe(-300);
  });

  it('counts defensive contributions against the position threshold', () => {
    expect(scoreMatch('DEF', line({ minutes: 90, defensive_contribution: 10 })).breakdown.defensive_contribution).toBe(200);
    expect(scoreMatch('MID', line({ minutes: 90, defensive_contribution: 10 })).breakdown.defensive_contribution).toBeUndefined();
  });

  it('caps a single match move', () => {
    expect(scoreMatch('DEF', line({ minutes: 90, goals: 6 })).changeBp).toBe(4000);
    expect(scoreMatch('FWD', line({ minutes: 10, red_cards: 1, own_goals: 3, penalties_missed: 2 })).changeBp).toBe(-2500);
  });
});

describe('applyChange', () => {
  it('moves by basis points and never drops below the floor', () => {
    expect(applyChange(550, 1000)).toBe(605);
    expect(applyChange(550, -2500)).toBe(413);
    expect(applyChange(11, -2500)).toBe(MIN_PRICE_PENCE);
  });
});

describe('money', () => {
  it('values whole cards at the current price', () => {
    expect(valueOf(3, 550)).toBe(1650);
  });

  it('takes a 2% fee on sales, rounded up', () => {
    expect(saleProceeds(2, 550)).toEqual({ gross: 1100, fee: 22, net: 1078 });
    expect(saleProceeds(1, 101)).toEqual({ gross: 101, fee: 3, net: 98 });
  });
});
