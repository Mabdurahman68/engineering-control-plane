export const TAX = 0.1;
export function total(prices) {
  const net = prices.reduce((a, b) => a + b, 0);
  return Math.round(net * (1 + TAX) * 100) / 100;
}
