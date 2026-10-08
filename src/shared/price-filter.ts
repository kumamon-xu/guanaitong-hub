import type { Product, ProductOffer } from './types';

export type PriceSort = 'default' | 'ascending' | 'descending';
export interface PriceFilterValue {
  amounts: number[];
  unit: string;
  sort: PriceSort;
}
export interface ResolvedPriceFilter {
  amounts: number[];
  unit: string;
  sort: PriceSort;
  hasAmounts: boolean;
  active: boolean;
  error: string | null;
}

// Every spread / read receives a fresh selection array, including callers that use {...EMPTY_PRICE_FILTER}.
export const EMPTY_PRICE_FILTER: PriceFilterValue = Object.freeze({ get amounts(): number[] { return []; }, unit: 'all', sort: 'default' });
const offerUnit = (offer: ProductOffer) => offer.priceUnit.trim() || '未标注单位';
const validAmount = (amount: unknown): amount is number => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
const knownPrice = (offer: ProductOffer): offer is ProductOffer & { price: number } => validAmount(offer.price);

export function resolvePriceFilter(value: PriceFilterValue): ResolvedPriceFilter {
  const validAmounts = Array.isArray(value.amounts) && value.amounts.every(validAmount);
  const hasAmounts = !Array.isArray(value.amounts) || value.amounts.length > 0;
  const unit = value.unit.trim() || 'all';
  let error: string | null = null;
  if (!validAmounts) error = '请选择大于或等于 0 的有效金额';
  else if (unit === 'all' && (hasAmounts || value.sort !== 'default')) error = '请选择价格单位，再选择金额或排序';
  return {
    amounts: validAmounts ? [...new Set(value.amounts)] : [], unit, sort: value.sort, hasAmounts,
    active: hasAmounts || unit !== 'all' || value.sort !== 'default', error,
  };
}

export function priceFilterUnits(products: readonly Product[], cardScope = 'all'): string[] {
  return [...new Set(products.flatMap(product => product.offers.filter(offer => cardScope === 'all' || offer.cardId === cardScope).map(offerUnit)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/** Actual current quotes only; no buckets, rounding, persisted option list, or inferred prices. */
export function priceFilterAmounts(products: readonly Product[], cardScope = 'all', unit = 'all'): number[] {
  const selectedUnit = unit.trim() || 'all';
  const prices = products.flatMap(product => product.offers.filter(offer =>
    (cardScope === 'all' || offer.cardId === cardScope) && (selectedUnit === 'all' || offerUnit(offer) === selectedUnit)
  ).filter(knownPrice).map(offer => offer.price));
  return [...new Set(prices)].sort((a, b) => a - b);
}

/** Returns the matching sources, with the cheapest known source first when their units are comparable. */
export function matchingPriceOffers(product: Product, cardScope: string, value: PriceFilterValue, matchesSource: (offer: ProductOffer) => boolean = () => true): ProductOffer[] {
  const filter = resolvePriceFilter(value);
  if (filter.error) return [];
  const selectedAmounts = new Set(filter.amounts);
  const matches = product.offers.filter(offer => {
    if (cardScope !== 'all' && offer.cardId !== cardScope) return false;
    if (filter.unit !== 'all' && offerUnit(offer) !== filter.unit) return false;
    if (!matchesSource(offer)) return false;
    if (!filter.hasAmounts) return true;
    if (!knownPrice(offer)) return false;
    return selectedAmounts.has(offer.price);
  });
  if (new Set(matches.map(offerUnit)).size > 1) return matches;
  return matches.sort((a, b) => {
    if (!knownPrice(a)) return knownPrice(b) ? 1 : 0;
    if (!knownPrice(b)) return -1;
    return a.price - b.price;
  });
}

export function productMatchesPrice(product: Product, cardScope: string, value: PriceFilterValue, matchesSource: (offer: ProductOffer) => boolean = () => true): boolean {
  return matchingPriceOffers(product, cardScope, value, matchesSource).length > 0;
}

/** Sorts by the displayed lowest available matching price; unpriced / unavailable products follow priced products. */
export function sortProductsByPrice(products: readonly Product[], cardScope: string, value: PriceFilterValue, isAvailable: (offer: ProductOffer) => boolean = () => true, matchesSource: (offer: ProductOffer) => boolean = () => true, includeWithoutOffers = false): Product[] {
  const filter = resolvePriceFilter(value);
  if (filter.error) return [];
  const matches = products.filter(product => productMatchesPrice(product, cardScope, value, matchesSource) || (includeWithoutOffers && !product.offers.length && cardScope === 'all' && filter.unit === 'all' && !filter.hasAmounts));
  if (filter.sort === 'default') return matches;
  const amounts = new Map(matches.map(product => {
    const prices = matchingPriceOffers(product, cardScope, value, matchesSource).filter(isAvailable).filter(knownPrice).map(offer => offer.price);
    return [product, prices.length ? Math.min(...prices) : null] as const;
  }));
  return matches.sort((a, b) => {
    const first = amounts.get(a)!, second = amounts.get(b)!;
    if (first === null) return second === null ? 0 : 1;
    if (second === null) return -1;
    return filter.sort === 'ascending' ? first - second : second - first;
  });
}
