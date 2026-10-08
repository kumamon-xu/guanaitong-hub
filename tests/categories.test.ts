// All storefront IDs and responses in this file are synthetic fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchProductCategories, parseCMSCategoryConfig, cmsProductSourceId, type CategoryRequest} from '../electron/categories';

const widget = {pageWidgetId: 100, productWidgetId: 200, pintuan: false, ecappCode: 'card_exchange', page: 1, limit: 200, total: 12};
const homeURL = 'https://cms.guanaitong.com/product/9999/99999.html';
function home(widgets = [widget]) {
  return `<script>var productWidgetList = ${JSON.stringify(widgets.slice(1))};
var storeProductRequest = ${JSON.stringify(widgets[0])};
storeProductRequest.storeId = "90001";
var pageSetting = {
storeId: "90001", mallType: 2
};</script>`;
}
const row = (code: string, inventoryId = 10, suitType = 1) => ({productCode: code, inventoryId, suitType});
const body = (rows: any[], total = rows.length, hasNext = false) => ({code: 0, data: {dataList: rows, totalCount: total, hasNext}});
const tree = [{inventoryId: 10, name: '50 额度区', productCategoryList: [{categoryId: 1, name: '食品饮料', subCategoryList: [{categoryId: 2, name: '米面粮油'}]}, {categoryId: 3, name: '家居生活'}]}];

test('public CMS configuration supports multiple widgets and rejects executable config', () => {
  const parsed = parseCMSCategoryConfig(home([widget, {...widget, pageWidgetId: 101, productWidgetId: 201}]));
  assert.equal(parsed.storeId, '90001');
  assert.equal(parsed.widgets.length, 2);
  assert.equal(parsed.widgets[1].pageWidgetId, 101);
  const pushed = home() + `<script>productWidgetList.push(${JSON.stringify({...widget, pageWidgetId: 102})});</script>`;
  assert.equal(parseCMSCategoryConfig(pushed).widgets.length, 2);
  assert.throws(() => parseCMSCategoryConfig(home().replace('"pintuan":false', '"pintuan":(()=>true)()')));
  assert.equal(cmsProductSourceId(row('P', 20, 2)), 'P:20:2');
});

test('official parent/leaf membership retains inventory, bundle type and uncategorized offers', async () => {
  const calls: any[] = [];
  const request: CategoryRequest = async (path, params, method) => {
    calls.push({path, params, method});
    if (path === 'product/cmsQueryProductCategory') return {code: 0, data: tree};
    if (params?.productCategoryId === '1') return body([row('RICE'), row('TEA')]);
    if (params?.productCategoryId === '2') return body([row('RICE')]);
    if (params?.productCategoryId === '3') return body([row('P', 10, 2)]);
    return body([row('RICE'), row('TEA'), row('P', 10, 2), row('OTHER')]);
  };
  const result = await fetchProductCategories(request, homeURL, 'c1', {loadHomeHTML: async () => home()});
  assert.equal(result.complete, true);
  assert.equal(result.cardId, 'c1');
  assert.deepEqual(result.bySourceId['RICE:10:1'], ['食品饮料', '米面粮油']);
  assert.deepEqual(result.bySourceId['TEA:10:1'], ['食品饮料']);
  assert.deepEqual(result.bySourceId['P:10:2'], ['家居生活']);
  assert.deepEqual(result.bySourceId['OTHER:10:1'], ['未分类']);
  assert.ok(!Object.values(result.bySourceId).flat().includes('50 额度区'));
  assert.deepEqual(calls[0], {path: 'product/cmsQueryProductCategory', params: {storeId: '90001', isPreview: 2}, method: 'POST'});
  for (const call of calls.slice(1)) {
    assert.equal(call.method, 'POST_JSON');
    assert.equal(call.params.ecappCode, 'card_exchange');
    assert.equal(call.params.total, 0);
  }
});

test('complete pagination combines multiple widgets and source inventories without cross assignment', async () => {
  const tree = [10, 20].map(inventoryId => ({inventoryId, productCategoryList: [{categoryId: inventoryId, name: inventoryId === 10 ? '食品' : '家居'}]}));
  const calls: Record<string, any>[] = [];
  const request: CategoryRequest = async (path, params) => {
    if (path === 'product/cmsQueryProductCategory') return {code: 0, data: tree};
    calls.push(params!);
    const inventory = params!.productCategoryId ? Number(params!.inventoryId) : (params!.pageWidgetId === 100 ? 10 : 20);
    const rows = [row('SHARED', inventory), row('BUNDLE', inventory, 2), row('LAST', inventory)];
    const start = (params!.page - 1) * params!.limit;
    return body(rows.slice(start, start + params!.limit), rows.length, start + params!.limit < rows.length);
  };
  const result = await fetchProductCategories(request, homeURL, 'c1', {loadHomeHTML: async () => home([widget, {...widget, pageWidgetId: 101, productWidgetId: 201}]), pageSize: 2});
  assert.equal(result.complete, true);
  assert.deepEqual(result.bySourceId['SHARED:10:1'], ['食品']);
  assert.deepEqual(result.bySourceId['SHARED:20:1'], ['家居']);
  assert.deepEqual(result.bySourceId['BUNDLE:20:2'], ['家居']);
  assert.equal(result.sourceIds.length, 6);
  assert.equal(calls.length, 12);
  assert.equal(calls.filter(call => call.page === 2).length, 6);
});

test('taxonomy remains isolated across cards even when an offer code is shared', async () => {
  const results = [];
  for (const [cardId, name] of [['c1', '食品饮料'], ['c2', '节日精选']]) {
    results.push(await fetchProductCategories(async path => path === 'product/cmsQueryProductCategory'
      ? {code: 0, data: [{inventoryId: 10, productCategoryList: [{categoryId: 1, name}]}]}
      : body([row('SHARED')]), homeURL, cardId, {loadHomeHTML: async () => home()}));
  }
  assert.deepEqual(results[0].bySourceId['SHARED:10:1'], ['食品饮料']);
  assert.deepEqual(results[1].bySourceId['SHARED:10:1'], ['节日精选']);
});

test('a failed category page cannot classify the successfully fetched first page', async () => {
  const result = await fetchProductCategories(async (path, params) => {
    if (path === 'product/cmsQueryProductCategory') return {code: 0, data: tree.slice(0, 1).map(inventory => ({...inventory, productCategoryList: [{categoryId: 1, name: '食品'}]}))};
    if (!params?.productCategoryId) return body([row('A'), row('B')]);
    return params.page === 1 ? body([row('A')], 2, true) : body([], 2, false);
  }, homeURL, 'c1', {loadHomeHTML: async () => home(), pageSize: 2});
  assert.equal(result.complete, false);
  assert.match(result.warnings[0], /不完整/);
  assert.equal(result.bySourceId['A:10:1'], undefined);
  assert.equal(result.bySourceId['B:10:1'], undefined);
  assert.deepEqual(result.sourceIds, ['A:10:1', 'B:10:1']);
});

test('repeated pagination and cross inventory responses are rejected without aborting caller', async () => {
  for (const crossInventory of [false, true]) {
    const result = await fetchProductCategories(async (path, params) => {
      if (path === 'product/cmsQueryProductCategory') return {code: 0, data: [{inventoryId: 10, productCategoryList: [{categoryId: 1, name: '食品'}]}]};
      if (!params?.productCategoryId) return body([row('A')]);
      return body([row('A', crossInventory ? 20 : 10)], 2, true);
    }, homeURL, 'c1', {loadHomeHTML: async () => home()});
    assert.equal(result.complete, false);
    assert.match(result.warnings[0], crossInventory ? /其他兑换分组/ : /重复/);
    assert.equal(result.bySourceId['A:10:1'], undefined);
  }
});

test('unavailable taxonomy, unsupported homepage and malformed structures return useful warnings', async () => {
  const failed = await fetchProductCategories(async () => ({code: 1134301002, data: null}), homeURL, 'c1', {loadHomeHTML: async () => home()});
  assert.equal(failed.complete, false);
  assert.match(failed.warnings[0], /会话已过期/);
  let read = false;
  const foreign = await fetchProductCategories(async () => {throw new Error('must not request');}, 'https://evil.example/product/1/2.html', 'c1', {loadHomeHTML: async () => {read = true; return home();}});
  assert.equal(read, false);
  assert.equal(foreign.complete, false);
  assert.deepEqual(foreign.bySourceId, {});
  const malformed = await fetchProductCategories(async () => ({code: 0, data: [{inventoryId: 10, productCategoryList: [{categoryId: 1, name: '食品', subCategoryList: {}}]}]}), homeURL, 'c1', {loadHomeHTML: async () => home()});
  assert.equal(malformed.complete, false);
  assert.match(malformed.warnings[0], /子分类/);
});

test('catalog with no official product categories explicitly remains uncategorized', async () => {
  const result = await fetchProductCategories(async path => path === 'product/cmsQueryProductCategory'
    ? {code: 0, data: [{inventoryId: 10, name: '50 额度区', productCategoryList: []}]}
    : body([row('A')]), homeURL, 'c1', {loadHomeHTML: async () => home()});
  assert.equal(result.complete, true);
  assert.deepEqual(result.bySourceId['A:10:1'], ['未分类']);
});

test('partial category failure retains confirmed mappings and leaves old classification eligible for preservation', async () => {
  const result = await fetchProductCategories(async (path, params) => {
    if (path === 'product/cmsQueryProductCategory') return {code: 0, data: [{inventoryId: 10, productCategoryList: [{categoryId: 1, name: '食品'}, {categoryId: 2, name: '家居'}]}]};
    if (!params?.productCategoryId) return body([row('CONFIRMED'), row('OLD'), row('NEW')]);
    if (params.productCategoryId === '1') return body([row('CONFIRMED')]);
    throw new Error('官网分类读取超时');
  }, homeURL, 'c1', {loadHomeHTML: async () => home()});
  assert.equal(result.complete, false);
  assert.deepEqual(result.bySourceId['CONFIRMED:10:1'], ['食品']);
  assert.ok(!Object.hasOwn(result.bySourceId, 'OLD:10:1'));
  assert.ok(!Object.hasOwn(result.bySourceId, 'NEW:10:1'));
  assert.equal(result.sourceIds.length, 3);
  assert.match(result.warnings[0], /家居.*超时/);
});

test('classification reads are bounded to three simultaneous requests', async () => {
  let inFlight = 0; let maximum = 0;
  const result = await fetchProductCategories(async (path, params) => {
    if (path === 'product/cmsQueryProductCategory') return {code: 0, data: [{inventoryId: 10, productCategoryList: Array.from({length: 7}, (_, index) => ({categoryId: index + 1, name: '分类' + index}))}]};
    inFlight++; maximum = Math.max(maximum, inFlight);
    await new Promise<void>(resolve => setImmediate(resolve));
    inFlight--;
    return body(params?.productCategoryId ? [] : [row('A')]);
  }, homeURL, 'c1', {loadHomeHTML: async () => home()});
  assert.equal(result.complete, true);
  assert.equal(maximum, 3);
  assert.equal(inFlight, 0);
});
