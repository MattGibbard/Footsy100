// Money is in pence, shares in micro-shares (1 share = 1,000,000 micro).

export const MICRO = 1_000_000;
export const STARTING_CASH_PENCE = 10_000; // £100
export const SELL_FEE_BP = 200; // 2% fee on sales
export const MIN_TRADE_PENCE = 10; // 10p

// Rounds up so the shares are worth at least what was paid; valueOf rounds down,
// and flooring both made a £10 buy show as £9.99. The extra is under 1 micro-share.
export function sharesForAmount(amountPence: number, pricePence: number): number {
  return Math.ceil((amountPence * MICRO) / pricePence);
}

export function valueOf(sharesMicro: number, pricePence: number): number {
  return Math.floor((sharesMicro * pricePence) / MICRO);
}

export function saleProceeds(sharesMicro: number, pricePence: number) {
  const gross = valueOf(sharesMicro, pricePence);
  const fee = Math.ceil((gross * SELL_FEE_BP) / 10000);
  return { gross, fee, net: gross - fee };
}

export function formatPence(p: number): string {
  const sign = p < 0 ? '-' : '';
  return `${sign}£${(Math.abs(p) / 100).toFixed(2)}`;
}
