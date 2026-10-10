// Money is in pence, shares in micro-shares (1 share = 1,000,000 micro).

export const MICRO = 1_000_000;
export const STARTING_CASH_PENCE = 10_000; // £100
export const SELL_FEE_BP = 200; // 2% fee on sales
export const MIN_TRADE_PENCE = 10; // 10p

export function sharesForAmount(amountPence: number, pricePence: number): number {
  return Math.floor((amountPence * MICRO) / pricePence);
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
