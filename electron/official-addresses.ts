import type { AddressDraft, AddressPublishResult, OfficialAddress, RegionOption } from '../src/shared/types';
import { validateAddressDraft } from './addresses';
import { unwrap } from './adapter';

export type OfficialAddressRequest = (path: string, params?: Record<string, string | number>, method?: 'GET' | 'POST') => Promise<any>;
export type RegionFetcher = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'text'>>;
const REGIONS_CALLBACK = 'hubAddressRegions';
const REGIONS_ORIGIN = 'https://api-outer.guanaitong.com';
const MAX_OFFICIAL_ADDRESSES = 50;
const uncertainWrite = () => new Error('官网地址保存结果尚未确认，可能已经写入。请先查看官网地址列表，确认后再重试。');
const record = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

function stringField(value: unknown, label: string, required = false, maximum = 500, trim = true): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`官网${label}格式发生变化`);
  const result = trim ? String(value).trim() : String(value);
  if ((required && !result.trim()) || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`官网${label}格式发生变化`);
  return result;
}
function addressId(value: unknown): string {
  const id = stringField(value, '地址标识', true, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('官网地址标识格式发生变化');
  return id;
}
function regionId(value: unknown, required = false): string {
  const id = stringField(value, '地区标识', required, 20);
  if (id && !/^\d+$/.test(id)) throw new Error('地区标识须来自官网地区选项');
  return id;
}
function addressData(body: any): any { return record(body) && Object.hasOwn(body, 'code') ? unwrap(body) : body; }
function listRows(body: any): any[] {
  const data = addressData(body);
  const rows = Array.isArray(data) ? data : record(data) && Array.isArray(data.data_list) ? data.data_list : null;
  if (!rows || rows.length > 1000) throw new Error('官网地址列表格式发生变化');
  return rows;
}

/** Keeps delivery names and house numbers as supplied by the official address service. */
export function normalizeOfficialAddresses(body: unknown): OfficialAddress[] {
  const seen = new Set<string>();
  return listRows(body).map(row => {
    if (!record(row)) throw new Error('官网收货地址格式发生变化');
    const id = addressId(row.id);
    if (seen.has(id)) throw new Error('官网地址列表包含重复标识');
    seen.add(id);
    const area = stringField(row.area, '收货地区', true);
    const names = area.split(/\s+/);
    if (names.length < 3 || names.length > 4) throw new Error('官网收货地区层级无法识别，请在官网核对地址');
    const provinceId = regionId(row.province_id), cityId = regionId(row.city_id);
    const districtId = regionId(row.district_id), townId = regionId(row.town_id);
    // Older / enterprise records can be viewed even when region IDs are incomplete;
    // publishing separately requires complete official IDs.
    const address = stringField(row.address, '详细地址', true);
    const houseNo = stringField(row.house_no, '门牌号', false, 500, false);
    const zipcode = stringField(row.zipcode, '邮政编码');
    return {
      id, isDefault: row.is_default === 1 || row.is_default === '1',
      draft: {
        label: '', recipient: stringField(row.name, '收货人', true, 60), phone: stringField(row.mobile, '手机号', true, 20),
        province: names[0], city: names[1], district: names[2], town: names[3] || '',
        detail: `${address}${houseNo}`, postalCode: /^\d{6}$/.test(zipcode) ? zipcode : '', provinceId, cityId, districtId, townId,
      },
    };
  });
}

function normalizeRegions(value: unknown): RegionOption[] {
  let count = 0;
  const walk = (rows: unknown, depth: number): RegionOption[] => {
    if (!Array.isArray(rows) || depth > 5) throw new Error('官网地区列表格式发生变化');
    const seen = new Set<string>();
    return rows.map(row => {
      if (++count > 100000 || !record(row)) throw new Error('官网地区列表格式发生变化');
      const id = regionId(row.id, true), name = stringField(row.name, '地区名称', true, 80);
      if (seen.has(id)) throw new Error('官网地区列表包含重复标识');
      seen.add(id);
      if (row.children !== undefined && row.children !== null && !Array.isArray(row.children)) throw new Error('官网地区层级格式发生变化');
      return { id, name, children: row.children == null ? null : walk(row.children, depth + 1) };
    });
  };
  return walk(value, 0);
}

/** Public JSONP is parsed as JSON only; callback text is never evaluated. */
export async function fetchRegions(parentId?: string, fetcher: RegionFetcher = fetch): Promise<RegionOption[]> {
  const url = new URL(parentId === undefined ? '/address/getallleve4.json' : '/address/gettownaddress.json', REGIONS_ORIGIN);
  if (parentId !== undefined) url.searchParams.set('pid', regionId(parentId, true));
  url.searchParams.set('callback', REGIONS_CALLBACK);
  const response = await fetcher(url.toString(), { method: 'GET', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('官网地区列表暂时无法读取，请稍后重试');
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('官网地区列表超过读取上限');
  const match = /^\s*hubAddressRegions\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/.exec(text);
  if (!match) throw new Error('官网地区 JSONP 格式发生变化');
  let body: unknown;
  try { body = JSON.parse(match[1]); } catch { throw new Error('官网地区数据不是有效 JSON'); }
  return normalizeRegions(unwrap(body));
}

export function buildAddressPayload(value: AddressDraft, makeDefault: boolean): Record<string, string | number> {
  const draft = validateAddressDraft(value);
  if (draft.recipient.length < 2 || draft.recipient.length > 20) throw new Error('官网收货人须为 2 至 20 个字符');
  if (draft.detail.length < 2 || draft.detail.length > 100) throw new Error('官网详细地址须为 2 至 100 个字符');
  const provinceId = regionId(draft.provinceId, true), cityId = regionId(draft.cityId, true);
  const districtId = regionId(draft.districtId), townId = regionId(draft.townId, true);
  if (draft.town ? !districtId : !!districtId) throw new Error('请选择完整的官网地区：三级地区使用末级标识，四级地区须包含区县和街道标识');
  if (typeof makeDefault !== 'boolean') throw new Error('默认地址选项格式无效');
  return {
    name: draft.recipient, mobile: draft.phone, area: [draft.province, draft.city, draft.district, draft.town].join(' ').trim(),
    address: draft.detail, is_default: makeDefault ? 1 : 2,
    province_id: provinceId, city_id: cityId, district_id: districtId, town_id: townId,
  };
}

function sameDelivery(first: AddressDraft, second: AddressDraft): boolean {
  return (['recipient', 'phone', 'province', 'city', 'district', 'town', 'detail', 'provinceId', 'cityId', 'districtId', 'townId'] as const).every(key => first[key] === second[key]);
}

/** Only called after the user explicitly chooses a card and confirms publishing an address. */
export async function publishOfficialAddress(request: OfficialAddressRequest, value: AddressDraft, makeDefault: boolean): Promise<AddressPublishResult> {
  const payload = buildAddressPayload(value, makeDefault);
  const draft = validateAddressDraft(value);
  const common = unwrap(await request('common/getCommonInfo', {}, 'POST'));
  const deliveryType = common?.current_user_info?.post_address_type;
  if (deliveryType !== 1 && deliveryType !== '1') throw new Error('此卡未确认允许普通地址，或使用企业员工配送地址，请在官网管理收货地址');
  const listed = unwrap(await request('address/list', { page: 1, rows_per_page: MAX_OFFICIAL_ADDRESSES }, 'GET'));
  const existing = normalizeOfficialAddresses(listed);
  const duplicate = existing.find(address => sameDelivery(address.draft, draft));
  if (duplicate) return { id: duplicate.id, created: false };
  const total = listed?.total_count;
  if (listed?.has_next === true || (total != null && (!Number.isFinite(Number(total)) || Number(total) > existing.length))) throw new Error('官网地址列表尚未完整读取，请先在官网检查重复地址');
  if (existing.length >= MAX_OFFICIAL_ADDRESSES) throw new Error('官网已保存 50 个地址，请先在官网整理后再添加');
  // Never retry a mutation: a transport error can occur after the server commits it.
  let saved: any;
  try { saved = unwrap(await request('address/add', payload, 'POST')); } catch { throw uncertainWrite(); }
  let id: string;
  try { id = addressId(saved?.address_id); } catch { throw uncertainWrite(); }
  try {
    const detail = unwrap(await request('address/getById', { address_id: id }, 'GET'));
    const verified = normalizeOfficialAddresses([detail])[0];
    if (verified.id !== id || !sameDelivery(verified.draft, draft) || (makeDefault && !verified.isDefault)) throw uncertainWrite();
  } catch { throw uncertainWrite(); }
  return { id, created: true };
}
