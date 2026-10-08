import { createHash } from 'node:crypto';
import type { Card, Order, Product } from '../src/shared/types';
import type { SyncContext } from './sync-manager';

export const API_BASE = 'https://a.guanaitong.com/card-exchange-bff/api/';
export const LOGIN_URL = 'https://a.guanaitong.com/festival-exchange-pc/login';
export const ORDERS_URL = 'https://a.guanaitong.com/festival-exchange-pc/order/list';
export type APIRequest = (path: string, params?: Record<string, string | number>) => Promise<any>;
export class LoginRequired extends Error {}
const stableId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);
const numberOrNull = (value: unknown): number | null => {
  if(typeof value!=='number' && (typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value.trim())))return null;
  const number=Number(value);return Number.isFinite(number)&&number>=0?number:null;
};
export function officialURL(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'guanaitong.com' || u.hostname.endsWith('.guanaitong.com')); } catch { return false; }
}
export function productImageURL(value:string):boolean {
  try{const u=new URL(value);return u.protocol==='https:'&&(officialURL(value)||u.hostname.endsWith('.360buyimg.com'));}catch{return false;}
}
export function unwrap(body: any): any {
  if (body?.code === 1134301002) throw new LoginRequired('官网会话已过期，请点击「登录官网」重新验证。');
  if (body?.code !== 0 || body.data == null) throw new Error(String(body?.msg || '官网没有返回可用数据'));
  return body.data;
}
export function normalizeCard(current: any, card: Card): Partial<Card> {
  if (!current?.card_code) throw new LoginRequired('这张卡尚未登录，请在官网窗口完成验证。');
  if (String(current.card_code) !== card.number) throw new Error('官网会话属于另一张卡，已停止同步，避免串卡。');
  const balance = numberOrNull(current.balance);
  const expires = current.date_valid_to == null ? null : new Date(typeof current.date_valid_to === 'number' ? current.date_valid_to : String(current.date_valid_to).replace(' ', 'T') + '+08:00');
  const expiresAt = expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : null;
  const expired = !!expiresAt && Date.parse(expiresAt) <= Date.now();
  return { balance, balanceUnit: current.limited_type === 2 ? '单次任选额度' : '额度', expiresAt,
    status: expired ? 'expired' : balance === 0 ? 'exhausted' : current.is_usable === 1 ? 'active' : 'error',
    error: current.is_usable === 1 || balance === 0 || expired ? null : '官网显示卡片当前不可用，详情请查看官网。',
    syncedAt: new Date().toISOString() };
}
export function normalizeProducts(rows: any[], card: Card, current: any): Product[] {
  const now = new Date().toISOString();
  return rows.map(row => {
    if (!row.product_code || row.inventory_id == null || !row.product_title) throw new Error('商品接口字段发生变化，本次同步未覆盖历史数据。');
    const code = String(row.product_code); const sourceId = `${code}:${row.inventory_id}:${row.product_type ?? 1}`;
    const price = numberOrNull(row.price); const maxPrice = numberOrNull(row.max_price);
    const url = new URL('https://a.guanaitong.com/festival-exchange-pc/product-detail');
    url.searchParams.set('product_code', code); url.searchParams.set('inventory_id', String(row.inventory_id));
    url.searchParams.set('product_type', String(row.product_type ?? 1));
    if (current.coupon_id != null) url.searchParams.set('coupon_id', String(current.coupon_id));
    return { id: stableId(card.id + sourceId), name: String(row.product_title), brand: '',
      image: typeof row.product_head_pic_url === 'string' && productImageURL(row.product_head_pic_url) ? row.product_head_pic_url : '',
      category: '未分类', specification: '',
      // Only exact official product code + exact title with a single price can auto merge.
      mergeKey: price !== null && price === maxPrice ? `${code}:${row.product_type ?? 1}` : '',
      favorite: false, offers: [{cardId: card.id, sourceId, price, priceUnit: current.limited_type === 2 ? '单次任选额度' : '额度',
        stock: row.is_sold_out === 1 ? 0 : null, url, variant: String(row.product_title)+(price !== maxPrice && maxPrice !== null ? ' · 多规格，官网确认价格' : ' · 官网确认配送库存'), syncedAt: now }].map(o=>({...o,url:o.url.toString()})) };
  });
}
export function normalizeOrders(rows: any[], card: Card): Order[] {
  const statuses: Record<number, string> = {1:'待兑换',2:'已兑换',3:'已关闭',4:'已发货',5:'已完成',6:'已关闭',999:'部分发货'};
  return rows.map(row => {
    if (row.card_code != null && String(row.card_code) !== card.number) throw new Error('订单来源卡号不一致，已停止本次同步。');
    if (!row.shop_order_code) throw new Error('订单接口字段发生变化，本次同步未覆盖历史数据。');
    const shopOrderCode = String(row.shop_order_code);
    const sourceId = row.seller_order_code ? `${shopOrderCode}:${row.seller_order_code}` : shopOrderCode;
    const url = new URL('https://a.guanaitong.com/festival-exchange-pc/order/detail');
    url.searchParams.set('shop_order_code', shopOrderCode);
    if(row.seller_order_code) url.searchParams.set('seller_order_code', String(row.seller_order_code));
    const timestamp = numberOrNull(row.time_order_created ?? row.time_order_payed);
    return { id: stableId(card.id + sourceId), cardId: card.id, sourceId,
      name: (row.order_product_list ?? []).map((p: any) => `${p.product_name || p.product_title || '商品'} ×${p.purchase_num || 1}`).join('、') || '官网订单',
      status: row.trade_status===3 ? (row.time_order_payed?'已兑换':'已关闭') : statuses[row.trade_status] ?? `官网状态 ${row.trade_status ?? '未知'}`, amount: numberOrNull(row.order_price),
      createdAt: timestamp !== null ? new Date(timestamp).toISOString() : '', tracking: String(row.express_no ?? ''), url: url.toString() };
  });
}
async function paginated(request: APIRequest, path: string, params: Record<string, string | number>, pageSize: number, context?: SyncContext): Promise<any[]> {
  const rows: any[] = []; let total: number | null = null;
  const seen = new Set<string>();
  for(let page=1;page<=500;page++) {
    context?.signal.throwIfAborted();
    context?.progress(path==='product/list'?'products':'orders',page,rows.length,total);
    const data = unwrap(await request(path,{...params,page}));
    if(!Array.isArray(data.data_list)) throw new Error('官网目录结构发生变化，已保留上次数据。');
    const currentTotal = numberOrNull(data.total_count);
    if(currentTotal!==null&&(!Number.isInteger(currentTotal)||(total!==null&&currentTotal!==total)))throw new Error('官网分页总数变化，已停止本次同步');
    if(total === null) total = currentTotal;
    for(const row of data.data_list){
      const identity=path==='product/list'?JSON.stringify([row.product_code,row.inventory_id,row.product_type??1]):JSON.stringify([row.shop_order_code,row.seller_order_code??'']);
      if(seen.has(identity))throw new Error('官网分页返回重复记录，已停止本次同步');seen.add(identity);
    }
    rows.push(...data.data_list);
    context?.progress(path==='product/list'?'products':'orders',page,rows.length,total);
    if(data.has_next === false || (total !== null && rows.length >= total) || (data.has_next == null && data.data_list.length < pageSize)) {
      if(total !== null && rows.length !== total) throw new Error(`目录读取不完整（${rows.length}/${total}），本次同步已停止。`);
      return rows;
    }
    if(data.data_list.length === 0) throw new Error('官网分页返回空页，本次同步已停止。');
  }
  throw new Error('目录超过同步上限，已保留上次数据。');
}
export async function fetchSnapshot(request: APIRequest, card: Card, context?: SyncContext) {
  context?.signal.throwIfAborted();context?.progress('identity');
  const current = unwrap(await request('common/getCurrentInfo'));
  const metadata = normalizeCard(current,card);
  const products = await paginated(request,'product/list',{rows_per_page:100},100,context);
  const orders = await paginated(request,'exchangeOrder/list',{card_code:card.number},20,context);
  // Re-check identity before committing a full snapshot.
  const finalCurrent=unwrap(await request('common/getCurrentInfo'));
  const finalMetadata=normalizeCard(finalCurrent,card);
  context?.signal.throwIfAborted();
  return { card: {...metadata,...finalMetadata,productCount:products.length}, products:normalizeProducts(products,card,finalCurrent), orders:normalizeOrders(orders,card) };
}
