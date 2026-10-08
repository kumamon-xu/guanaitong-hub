import type { AppState } from '../src/shared/types';

export function maskCardNumber(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : `****${value.slice(-4)}`;
}
/** Use this for persisted log messages and diagnostic exports, never for the local credential vault. */
export function redactText(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已脱敏]');
  return text.replace(/(cookie|authorization|password|passwd|密码)\s*[:=]\s*[^\s;,]+/gi, '$1=[已脱敏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已脱敏]')
    .replace(/\b\d{9,32}\b/g, value => maskCardNumber(value));
}
export function diagnosticSummary(state: AppState): object {
  return {
    format: 'guanaitong-diagnostics', version: 1, exportedAt: new Date().toISOString(),
    cards: state.cards.map(card => ({ number: maskCardNumber(card.number), status: card.status, balanceKnown: card.balance !== null, archived: card.archived, productCount: card.productCount, syncedAt: card.syncedAt, hasError: !!card.error })),
    counts: { cards: state.cards.length, products: state.products.length, offers: state.products.reduce((sum, item) => sum + item.offers.length, 0), orders: state.orders.length, cart: state.cart.length },
  };
}
