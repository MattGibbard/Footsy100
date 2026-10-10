// Money is in pence. Players are bought and sold as whole cards at the current price.

export const STARTING_CASH_PENCE = 10_000; // £100
export const SELL_FEE_BP = 200; // 2% fee on sales
export const MAX_CARDS_PER_TRADE = 1000;

export function valueOf(cards: number, pricePence: number): number {
  return cards * pricePence;
}

export function saleProceeds(cards: number, pricePence: number) {
  const gross = valueOf(cards, pricePence);
  const fee = Math.ceil((gross * SELL_FEE_BP) / 10000);
  return { gross, fee, net: gross - fee };
}

export function formatPence(p: number): string {
  const sign = p < 0 ? '-' : '';
  return `${sign}£${(Math.abs(p) / 100).toFixed(2)}`;
}
