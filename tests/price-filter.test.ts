import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Product, ProductOffer } from '../src/shared/types';
import { EMPTY_PRICE_FILTER, matchingPriceOffers, priceFilterAmounts, priceFilterUnits, productMatchesPrice, resolvePriceFilter, sortProductsByPrice, type PriceFilterValue } from '../src/shared/price-filter';

function offer(cardId: string, price: number | null, unit = '额度', sourceId = cardId + '-' + price + '-' + unit): ProductOffer {
  return { cardId, sourceId, price, priceUnit: unit, stock: null, url: '', variant: '', syncedAt: '2026-10-02T04:00:00Z' };
}
function product(id: string, offers: ProductOffer[]): Product {
  return { id, name: id, brand: '', image: '', category: '未分类', specification: '', offers, mergeKey: id, favorite: false };
}
const filter = (overrides: Partial<PriceFilterValue> = {}): PriceFilterValue => ({ ...EMPTY_PRICE_FILTER, unit: '额度', ...overrides });

test('multiple selected amounts match exact alternatives, never intermediate prices', () => {
  const shared = product('same item', [offer('a', 25), offer('b', 50), offer('c', 75), offer('d', 100)]);
  const selected = filter({ amounts: [50, 100] });
  assert.equal(productMatchesPrice(shared, 'all', selected), true);
  assert.deepEqual(matchingPriceOffers(shared, 'all', selected).map(item => item.cardId), ['b', 'd']);
  assert.equal(productMatchesPrice(product('middle', [offer('a', 75)]), 'all', selected), false);
  assert.equal(productMatchesPrice(product('outside', [offer('a', 125)]), 'all', selected), false);
});

test('both selectable amounts and exact source matches respect the chosen card scope', () => {
  const shared = product('same item', [offer('card-a', 20), offer('card-b', 100), offer('card-c', 200)]);
  const selected = filter({ amounts: [100, 200] });
  assert.deepEqual(priceFilterAmounts([shared]), [20, 100, 200]);
  assert.deepEqual(priceFilterAmounts([shared], 'card-a'), [20]);
  assert.deepEqual(priceFilterAmounts([shared], 'missing-card'), []);
  assert.equal(productMatchesPrice(shared, 'card-a', selected), false);
  assert.equal(productMatchesPrice(shared, 'card-b', selected), true);
  assert.deepEqual(matchingPriceOffers(shared, 'card-c', selected).map(item => item.cardId), ['card-c']);
});

test('unit selection separates allowance, cash and points even at the same numeric amount', () => {
  const shared = product('multiple units', [offer('a', 30, '元'), offer('b', 100), offer('c', 30, '积分'), offer('d', 50, '单次任选额度')]);
  assert.deepEqual(priceFilterUnits([shared]), ['单次任选额度', '额度', '积分', '元']);
  assert.deepEqual(priceFilterUnits([shared], 'a'), ['元']);
  assert.deepEqual(priceFilterAmounts([shared]), [30, 50, 100]);
  assert.deepEqual(priceFilterAmounts([shared], 'all', '额度'), [100]);
  assert.deepEqual(priceFilterAmounts([shared], 'a', '额度'), []);
  assert.equal(productMatchesPrice(shared, 'all', filter({ amounts: [30] })), false);
  assert.deepEqual(matchingPriceOffers(shared, 'all', filter({ unit: '元', amounts: [30] })).map(item => item.cardId), ['a']);
  assert.deepEqual(matchingPriceOffers(shared, 'all', EMPTY_PRICE_FILTER).map(item => item.cardId), ['a', 'b', 'c', 'd']);
  assert.match(resolvePriceFilter({ ...EMPTY_PRICE_FILTER, amounts: [30] }).error!, /价格单位/);
  assert.match(resolvePriceFilter({ ...EMPTY_PRICE_FILTER, sort: 'ascending' }).error!, /价格单位/);
});

test('synced price changes and new card offers immediately produce a new option list without mutating prior data', () => {
  const previous = [product('shared', [offer('card-a', 50), offer('card-b', 100)]), product('duplicate', [offer('card-a', 50)])];
  const updated = [product('shared', [offer('card-a', 75), offer('card-b', 100), offer('card-c', 200)]), product('new', [offer('card-a', 125)])];
  assert.deepEqual(priceFilterAmounts(previous), [50, 100]);
  assert.deepEqual(priceFilterAmounts(updated), [75, 100, 125, 200]);
  assert.deepEqual(priceFilterAmounts(updated, 'card-a'), [75, 125]);
  assert.deepEqual(priceFilterAmounts(previous), [50, 100]);
  assert.equal(productMatchesPrice(previous[0], 'card-a', filter({ amounts: [50] })), true);
  assert.equal(productMatchesPrice(updated[0], 'card-a', filter({ amounts: [50] })), false);
});

test('unknown prices are retained only without an amount selection; zero and exact decimals remain selectable', () => {
  const unknown = product('unknown', [offer('a', null), offer('b', Number.NaN), offer('c', Infinity), offer('d', -1)]);
  const decimal = product('decimal', [offer('a', 0), offer('b', 0.1), offer('c', 0.3), offer('d', 0.1 + 0.2)]);
  assert.deepEqual(priceFilterAmounts([unknown, decimal]), [0, 0.1, 0.3, 0.1 + 0.2]);
  assert.equal(productMatchesPrice(unknown, 'all', EMPTY_PRICE_FILTER), true);
  assert.equal(productMatchesPrice(unknown, 'a', filter()), true);
  assert.equal(productMatchesPrice(unknown, 'all', filter({ amounts: [0] })), false);
  assert.deepEqual(matchingPriceOffers(decimal, 'all', filter({ amounts: [0, 0.1, 0.3] })).map(item => item.cardId), ['a', 'b', 'c']);
  assert.equal(productMatchesPrice(decimal, 'd', filter({ amounts: [0.3] })), false);
});

test('invalid selected amounts fail visibly; resolving and empty filters never share mutable selection arrays', () => {
  for (const invalid of [NaN, Infinity, -1, '50' as unknown as number]) {
    const selected = filter({ amounts: [50, invalid] });
    assert.match(resolvePriceFilter(selected).error!, /有效金额/);
    assert.equal(productMatchesPrice(product('item', [offer('a', 50)]), 'all', selected), false);
  }
  const input = filter({ amounts: [50, 50, 100] });
  const resolved = resolvePriceFilter(input);
  assert.equal(resolved.error, null);
  assert.equal(resolved.hasAmounts, true);
  assert.deepEqual(resolved.amounts, [50, 100]);
  resolved.amounts.push(200);
  assert.deepEqual(input.amounts, [50, 50, 100]);
  const first = { ...EMPTY_PRICE_FILTER }, second = { ...EMPTY_PRICE_FILTER };
  first.amounts.push(50);
  assert.deepEqual(second.amounts, []);
  assert.deepEqual(EMPTY_PRICE_FILTER.amounts, []);
  assert.equal(resolvePriceFilter(second).active, false);
});

test('source selection starts with the cheapest exact matched quote and preserves original source order', () => {
  const shared = product('shared', [offer('a', 25), offer('b', 100), offer('c', 50), offer('d', null)]);
  assert.deepEqual(matchingPriceOffers(shared, 'all', filter({ amounts: [50, 100] })).map(item => item.cardId), ['c', 'b']);
  assert.deepEqual(shared.offers.map(item => item.cardId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(matchingPriceOffers(shared, 'all', filter()).map(item => item.cardId), ['a', 'c', 'b', 'd']);
});

test('price sorting uses the lowest exact matched source and puts unknown prices last in both directions', () => {
  const expensive = product('expensive', [offer('a', 200)]);
  const shared = product('shared', [offer('a', 10), offer('b', 100)]);
  const unknown = product('unknown', [offer('a', null)]);
  const tied = product('tied', [offer('a', 100)]);
  const list = [unknown, expensive, shared, tied];
  assert.deepEqual(sortProductsByPrice(list, 'all', filter({ sort: 'ascending' })).map(item => item.id), ['shared', 'tied', 'expensive', 'unknown']);
  assert.deepEqual(sortProductsByPrice(list, 'all', filter({ sort: 'descending' })).map(item => item.id), ['expensive', 'tied', 'shared', 'unknown']);
  assert.deepEqual(sortProductsByPrice(list, 'all', filter({ amounts: [100, 200], sort: 'ascending' })).map(item => item.id), ['shared', 'tied', 'expensive']);
  assert.deepEqual(sortProductsByPrice([shared], 'a', filter({ amounts: [100, 200], sort: 'ascending' })), []);
  assert.deepEqual(list.map(item => item.id), ['unknown', 'expensive', 'shared', 'tied']);
});

test('sorting uses available display prices while preserving matches whose selected quotes are all unavailable', () => {
  const shared = product('shared', [offer('archived-card', 20), { ...offer('active-card', 30), stock: 0 }, offer('active-card', 100)]);
  const available = product('available', [offer('active-card', 70)]);
  const unavailable = product('unavailable', [offer('archived-card', 10), { ...offer('active-card', 40), stock: 0 }]);
  const list = [unavailable, shared, available];
  const offerAvailable = (source: ProductOffer) => source.cardId !== 'archived-card' && source.stock !== 0;
  assert.deepEqual(sortProductsByPrice(list, 'all', filter({ sort: 'ascending' }), offerAvailable).map(item => item.id), ['available', 'shared', 'unavailable']);
  assert.deepEqual(sortProductsByPrice(list, 'all', filter({ sort: 'descending' }), offerAvailable).map(item => item.id), ['shared', 'available', 'unavailable']);
  assert.deepEqual(sortProductsByPrice([shared, available], 'all', filter({ amounts: [20, 70], sort: 'ascending' }), offerAvailable).map(item => item.id), ['available', 'shared']);
  assert.deepEqual(sortProductsByPrice([shared, available], 'all', filter({ amounts: [20, 70], sort: 'descending' }), offerAvailable).map(item => item.id), ['available', 'shared']);
  assert.deepEqual(sortProductsByPrice(list, 'all', filter({ sort: 'ascending' })).map(item => item.id), ['unavailable', 'shared', 'available']);
  assert.deepEqual(sortProductsByPrice(list, 'all', filter(), offerAvailable).map(item => item.id), ['unavailable', 'shared', 'available']);
  assert.deepEqual(list.map(item => item.id), ['unavailable', 'shared', 'available']);
});

test('category and selected amount must match the same source, including default sources and sorting', () => {
  const shared = product('shared', [{ ...offer('card-a', 50), categories: ['食品'] }, { ...offer('card-b', 100), categories: ['家居'] }]);
  const cheaperFood = product('cheaper-food', [{ ...offer('card-c', 40), categories: ['食品'] }]);
  const foodSource = (source: ProductOffer) => !!source.categories?.includes('食品');
  assert.equal(productMatchesPrice(shared, 'all', filter({ amounts: [100] }), foodSource), false);
  assert.deepEqual(matchingPriceOffers(shared, 'all', filter({ amounts: [100] }), foodSource), []);
  assert.deepEqual(matchingPriceOffers(shared, 'all', filter({ amounts: [50] }), foodSource).map(item => item.cardId), ['card-a']);
  assert.deepEqual(sortProductsByPrice([shared], 'all', filter({ amounts: [100], sort: 'ascending' }), undefined, foodSource), []);
  assert.deepEqual(sortProductsByPrice([shared, cheaperFood], 'all', filter({ amounts: [40, 50, 100], sort: 'ascending' }), undefined, foodSource).map(item => item.id), ['cheaper-food', 'shared']);
  assert.deepEqual(sortProductsByPrice([cheaperFood, shared], 'all', filter({ amounts: [40, 50, 100], sort: 'descending' }), undefined, foodSource).map(item => item.id), ['shared', 'cheaper-food']);
  assert.deepEqual(matchingPriceOffers(shared, 'card-b', filter(), foodSource), []);
});
