import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressDraft } from '../src/shared/types';
import { buildAddressPayload, fetchRegions, normalizeOfficialAddresses, publishOfficialAddress, type OfficialAddressRequest } from '../electron/official-addresses';

const draft = (overrides: Partial<AddressDraft> = {}): AddressDraft => ({
  label: '测试地址', recipient: '测试收货人', phone: '13800000000', province: '上海市', city: '市辖区', district: '徐汇区', town: '天平路街道',
  detail: '测试路 123 号', postalCode: '200000', provinceId: '310000', cityId: '310100', districtId: '310104', townId: '310104003', ...overrides,
});
const official = (value = draft(), overrides: Record<string, any> = {}) => ({
  id: '100', name: value.recipient, mobile: value.phone, area: [value.province, value.city, value.district, value.town].join(' ').trim(),
  address: value.detail, is_default: 1, province_id: value.provinceId, city_id: value.cityId, district_id: value.districtId, town_id: value.townId, house_no: '', ...overrides,
});
const ok = (data: any) => ({ code: 0, data });

test('address normalization preserves official area names and house numbers, including three-level regions', () => {
  const threeLevel = draft({ town: '', districtId: '', townId: '310104' });
  const result = normalizeOfficialAddresses(ok({ data_list: [official(draft(), { address: '测试路', house_no: ' 123 号' }), official(threeLevel, { id: '101', is_default: 2 })] }));
  assert.equal(result[0].draft.detail, '测试路 123 号');
  assert.equal(result[0].draft.town, '天平路街道');
  assert.equal(result[0].isDefault, true);
  assert.equal(result[1].draft.district, '徐汇区');
  assert.equal(result[1].draft.town, '');
  assert.equal(result[1].draft.districtId, '');
  assert.equal(result[1].draft.townId, '310104');
  assert.equal(result[1].isDefault, false);
  assert.equal(normalizeOfficialAddresses([official(draft(), { zipcode: '200000' })])[0].draft.postalCode, '200000');
  assert.equal(normalizeOfficialAddresses([official(draft(), { zipcode: 'invalid' })])[0].draft.postalCode, '');
  assert.throws(() => normalizeOfficialAddresses({ data_list: [official(), official()] }), /重复标识/);
  assert.throws(() => normalizeOfficialAddresses({ data_list: [official(draft(), { area: '上海市徐汇区' })] }), /层级/);
});

test('ordinary payload uses official IDs and flags, and never publishes local labels, postal codes or enterprise fields', () => {
  assert.deepEqual(buildAddressPayload(draft(), true), {
    name: '测试收货人', mobile: '13800000000', area: '上海市 市辖区 徐汇区 天平路街道', address: '测试路 123 号',
    is_default: 1, province_id: '310000', city_id: '310100', district_id: '310104', town_id: '310104003',
  });
  const threeLevel = buildAddressPayload(draft({ town: '', districtId: '', townId: '310104' }), false);
  assert.equal(threeLevel.area, '上海市 市辖区 徐汇区');
  assert.equal(threeLevel.district_id, '');
  assert.equal(threeLevel.town_id, '310104');
  assert.equal(threeLevel.is_default, 2);
  assert.throws(() => buildAddressPayload(draft({ provinceId: '' }), false), /地区标识/);
  assert.throws(() => buildAddressPayload(draft({ townId: '' }), false), /地区标识/);
  assert.throws(() => buildAddressPayload(draft({ districtId: '' }), false), /完整的官网地区/);
  assert.throws(() => buildAddressPayload(draft({ town: '', townId: '310104' }), false), /完整的官网地区/);
  assert.throws(() => buildAddressPayload(draft({ townId: 'guessed-id' }), false), /官网地区选项/);
});

test('publishing enforces the official recipient and detail length limits rather than only local-book limits', () => {
  for (const recipient of ['单', '字'.repeat(21)]) assert.throws(() => buildAddressPayload(draft({ recipient }), false), /收货人须为 2 至 20/);
  for (const detail of ['路', '址'.repeat(101)]) assert.throws(() => buildAddressPayload(draft({ detail }), false), /详细地址须为 2 至 100/);
  assert.equal(buildAddressPayload(draft({ recipient: '张三', detail: '家里' }), false).name, '张三');
  assert.equal(buildAddressPayload(draft({ recipient: '字'.repeat(20), detail: '址'.repeat(100) }), false).address, '址'.repeat(100));
});

test('public regions use only the official HTTPS URLs and parse callback JSON without executing script', async () => {
  const calls: { url: string; credentials?: RequestCredentials }[] = [];
  const fetcher = async (url: string, options?: RequestInit) => {
    calls.push({ url, credentials: options?.credentials });
    return { ok: true, text: async () => 'hubAddressRegions({"code":0,"data":[{"id":"310000","name":"上海市","children":[{"id":"310100","name":"市辖区","children":null}]}]});' };
  };
  const root = await fetchRegions(undefined, fetcher);
  assert.equal(root[0].children?.[0].name, '市辖区');
  assert.equal(new URL(calls[0].url).origin, 'https://api-outer.guanaitong.com');
  assert.equal(new URL(calls[0].url).pathname, '/address/getallleve4.json');
  assert.equal(calls[0].credentials, 'omit');
  const towns = await fetchRegions('310104', async url => {
    assert.equal(new URL(url).pathname, '/address/gettownaddress.json');
    assert.equal(new URL(url).searchParams.get('pid'), '310104');
    assert.equal(new URL(url).searchParams.get('callback'), 'hubAddressRegions');
    return { ok: true, text: async () => 'hubAddressRegions({"code":0,"data":[{"id":"310104003","name":"天平路街道"}]})' };
  });
  assert.deepEqual(towns, [{ id: '310104003', name: '天平路街道', children: null }]);
  for (const text of ['evilCallback({"code":0,"data":[]})', 'hubAddressRegions({"code":0,"data":[]});globalThis.injected=true', 'hubAddressRegions({code:0,data:[]})']) {
    await assert.rejects(fetchRegions(undefined, async () => ({ ok: true, text: async () => text })), /格式|JSON/);
  }
  await assert.rejects(fetchRegions('310104&callback=evil', fetcher), /地区标识/);
  assert.equal(calls.length, 1);
});

test('unknown and enterprise delivery policies stop before listing or adding an address', async () => {
  for (const postAddressType of [undefined, null, 0, 2, 3, 'unknown']) {
    const calls: string[] = [];
    await assert.rejects(publishOfficialAddress(async (path, params, method) => {
      calls.push(path);
      assert.equal(method, 'POST');
      return ok({ post_address_type: 1, current_user_info: { post_address_type: postAddressType } });
    }, draft(), false), /企业员工配送地址/);
    assert.deepEqual(calls, ['common/getCommonInfo']);
  }
});

test('exact duplicate returns existing ID without toggling its default flag or issuing a mutation', async () => {
  const calls: string[] = [];
  const result = await publishOfficialAddress(async path => {
    calls.push(path);
    if (path === 'common/getCommonInfo') return ok({ current_user_info: { post_address_type: 1 } });
    if (path === 'address/list') return ok({ data_list: [official(draft(), { is_default: 2 })] });
    throw new Error('unexpected mutation');
  }, draft(), true);
  assert.deepEqual(result, { id: '100', created: false });
  assert.deepEqual(calls, ['common/getCommonInfo', 'address/list']);
});

test('a single successful add is read back and verified against exact delivery fields', async () => {
  const calls: { path: string; method?: string }[] = [];
  const request: OfficialAddressRequest = async (path, params, method) => {
    calls.push({ path, method });
    if (path === 'common/getCommonInfo') return ok({ current_user_info: { post_address_type: '1' } });
    if (path === 'address/list') return ok({ data_list: [] });
    if (path === 'address/add') { assert.deepEqual(params, buildAddressPayload(draft(), true)); return ok({ address_id: 100 }); }
    if (path === 'address/getById') { assert.deepEqual(params, { address_id: '100' }); return ok(official()); }
    throw new Error('unknown path');
  };
  assert.deepEqual(await publishOfficialAddress(request, draft(), true), { id: '100', created: true });
  assert.deepEqual(calls, [{ path: 'common/getCommonInfo', method: 'POST' }, { path: 'address/list', method: 'GET' }, { path: 'address/add', method: 'POST' }, { path: 'address/getById', method: 'GET' }]);
});

test('ambiguous writes and mismatched readbacks never retry and instruct checking the official list', async () => {
  for (const outcome of ['network', 'error-response', 'missing-id', 'wrong-recipient', 'wrong-id', 'wrong-default', 'read-error']) {
    const calls: string[] = [];
    await assert.rejects(publishOfficialAddress(async path => {
      calls.push(path);
      if (path === 'common/getCommonInfo') return ok({ current_user_info: { post_address_type: 1 } });
      if (path === 'address/list') return ok({ data_list: [] });
      if (path === 'address/add') {
        if (outcome === 'network') throw new Error('socket lost after write');
        if (outcome === 'error-response') return { code: 4, msg: 'rejected' };
        return ok(outcome === 'missing-id' ? {} : { address_id: '100' });
      }
      if (outcome === 'read-error') throw new Error('read failed');
      return ok(official(draft(), outcome === 'wrong-recipient' ? { name: '其他人' } : outcome === 'wrong-id' ? { id: '101' } : { is_default: 2 }));
    }, draft(), true), /可能已经写入.*官网地址列表/);
    assert.equal(calls.filter(path => path === 'address/add').length, 1);
    if (['network', 'error-response', 'missing-id'].includes(outcome)) assert.equal(calls.includes('address/getById'), false);
  }
});

test('address limit and incomplete preflight lists block writes without deleting or altering existing records', async () => {
  for (const listed of [{ data_list: Array.from({ length: 50 }, (_, index) => official(draft({ detail: `其他地址 ${index}` }), { id: String(index + 1) })) }, { data_list: [], has_next: true }, { data_list: [], total_count: 20 }]) {
    const calls: string[] = [];
    await assert.rejects(publishOfficialAddress(async path => { calls.push(path); return ok(path === 'common/getCommonInfo' ? { current_user_info: { post_address_type: 1 } } : listed); }, draft(), false), /50 个地址|完整读取/);
    assert.deepEqual(calls, ['common/getCommonInfo', 'address/list']);
  }
});
