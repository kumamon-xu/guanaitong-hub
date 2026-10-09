import { productImageURL } from './adapter';
import { normalizeOfficialAddresses } from './official-addresses';
import type { OfficialAddress, ProductOffer } from '../src/shared/types';
import type { TradePackageItem, TradePreviewLine, TradeProduct, TradeSelection, TradeSku } from '../src/shared/trade';

export function tradeId(value: unknown, field: string): string {
  if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0))throw new Error(field+'标识无效');
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 500 || /[\r\n\0]/.test(String(value))) throw new Error(field + '标识无效');
  return String(value);
}
export function tradeAmount(value: unknown, field: string): number {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e12) throw new Error(field + '未知或格式无效');
  return Number(value);
}
function amountOrNull(value: unknown): number | null { if (value == null) return null; return tradeAmount(value, '商品数值'); }
const text = (value: unknown, maximum = 500): string => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\0]/g, '').slice(0, maximum) : '';
export function sourceIdentity(offer: ProductOffer): { product_code: string; inventory_id: string; product_type: number } {
  const parts = offer.sourceId.split(':');
  if (parts.length !== 3 || !['1', '2'].includes(parts[2])) throw new Error('商品来源不能用于直接兑换，请重新同步');
  return { product_code: tradeId(parts[0], '商品'), inventory_id: tradeId(parts[1], '库存池'), product_type: Number(parts[2]) };
}
function skus(value: unknown): TradeSku[] {
  if (!value || typeof value !== 'object') throw new Error('商品规格响应缺失');
  const rows = Array.isArray(value) ? value : Object.values(value);
  if (!rows.length || rows.length > 1000) throw new Error('商品规格数量无效');
  const seen = new Set<string>();
  return rows.map((row: any) => {
    const code = tradeId(row?.code, '规格'); if (seen.has(code)) throw new Error('商品规格重复'); seen.add(code);
    const stock = amountOrNull(row.stock), limit = amountOrNull(row.limit_purchase_num);
    if ((stock !== null && !Number.isInteger(stock)) || (limit !== null && !Number.isInteger(limit))) throw new Error('规格库存或限购数量无效');
    const label = text(row.name || row.sku_title) || code;
    return { code, label, price: amountOrNull(row.price), stock, limit: limit || null, properties: [] };
  });
}
export function normalizeTradeProduct(value: any, productId: string, offer: ProductOffer): TradeProduct {
  const identity = sourceIdentity(offer);
  if (!value || String(value.product_code) !== identity.product_code || String(value.inventory_id) !== identity.inventory_id || Number(value.product_type) !== identity.product_type || ![1, 2].includes(value.type)) throw new Error('商品详情与选定卡片来源不一致');
  const packageItems: TradePackageItem[] = [];
  if (identity.product_type === 2) {
    if (!Array.isArray(value.package_item_list) || !value.package_item_list.length || value.package_item_list.length > 50) throw new Error('组合商品子规格缺失');
    for (const row of value.package_item_list) {
      const choices = skus(row.sku_info);
      const originalSku = tradeId(row.sku_code ?? row.default_sku_code ?? (choices.length === 1 ? choices[0].code : undefined), '组合原规格');
      if (!choices.some(sku => sku.code === originalSku)) throw new Error('组合原规格不在商品候选中');
      const quantity = tradeAmount(row.item_num, '组合数量'); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('组合数量无效');
      packageItems.push({ productCode: tradeId(row.spu_code, '组合子商品'), name: text(row.product_name || row.title) || '组合商品', quantity, originalSku, skus: choices });
    }
  }
  const image = value.main_pic_urls?.[0];
  return { productId, sourceId: offer.sourceId, cardId: offer.cardId, productCode: identity.product_code, inventoryId: identity.inventory_id,
    name: text(value.title || value.product_name) || '商品', image: typeof image === 'string' && productImageURL(image) ? image : '',
    type: value.type, productType: identity.product_type, skus: identity.product_type === 1 ? skus(value.sku_info) : [{ code: identity.product_code, label: '组合商品', price: amountOrNull(value.min_price), stock: amountOrNull(value.spu_stock), limit: null, properties: [] }],
    packageItems, stock: amountOrNull(value.spu_stock), description: text(value.selling_point || value.delivery_notice, 2000) };
}
export function verifySelection(detail: TradeProduct, item: TradeSelection): TradeSku {
  const sku = detail.skus.find(sku => sku.code === item.skuCode);
  if (!sku || sku.stock === 0 || (sku.stock !== null && item.quantity > sku.stock) || (sku.limit !== null && item.quantity > sku.limit)) throw new Error('所选规格已失效、库存不足或超过限购数量');
  if (detail.productType === 1 && item.packageReplacements?.length) throw new Error('普通商品不能携带组合替换项');
  const replacements = new Map<string, string>();
  for (const row of item.packageReplacements ?? []) { if (replacements.has(row.originalSku)) throw new Error('组合替换规格重复'); replacements.set(row.originalSku, row.skuCode); }
  for (const row of detail.packageItems) {
    const choice = row.skus.find(sku => sku.code === (replacements.get(row.originalSku) ?? row.originalSku));
    if (!choice || choice.stock === 0 || (choice.stock !== null && item.quantity * row.quantity > choice.stock)) throw new Error('组合子商品规格或库存无效');
    replacements.delete(row.originalSku);
  }
  if (replacements.size) throw new Error('组合替换包含其他商品规格');
  return sku;
}
export function validateTradeAddresses(rows: any, number: string): OfficialAddress[] {
  if (!rows || !Array.isArray(rows.data_list)) throw new Error('官网地址响应格式无效');
  for (const row of rows.data_list) if (row.card_code != null && String(row.card_code) !== number) throw new Error('官网地址来自另一张卡，已停止结算');
  return normalizeOfficialAddresses(rows);
}
export interface SettlementResult { lines: TradePreviewLine[]; deduction: number; pieces: number; freight: number; payload: Record<string, unknown>; }
/** Build only from current server settlement rows, never renderer prices or cached cart totals. */
export function normalizeSettlement(value: any, input: TradeSelection[], details: TradeProduct[], address: OfficialAddress, remark: string): SettlementResult {
  if (!value || !Array.isArray(value.settlement_item) || !value.settlement_item.length || value.settlement_item.length > 50 || !Array.isArray(value.invalid_product_list) || value.invalid_product_list.length) throw new Error('部分商品不可兑换，请重新选择商品或地址');
  if (value.is_need_verify === 1 || value.is_need_verify === true) throw new Error('官网要求额外验证，本次未提交订单');
  if (value.is_need_verify !== 2 && value.is_need_verify !== 0 && value.is_need_verify !== false) throw new Error('官网验证要求未知，本次未提交订单');
  if (value.is_jd_direct_charge_product === 1 || value.is_exist_cycle_product === 1) throw new Error('当前商品要求充值或周期配送专用信息，请选择普通兑换商品');
  const deduction = tradeAmount(value.total_amount, '结算兑换额'), pieces = tradeAmount(value.total_pieces, '结算件数');
  if (!Number.isInteger(pieces) || pieces < 1) throw new Error('结算件数无效');
  const expected = new Map(input.map((item, index) => [details[index].inventoryId + ':' + item.skuCode, { item, detail: details[index] }]));
  if(expected.size!==input.length)throw new Error('同一库存规格请合并数量后结算');
  const seen = new Set<string>(), lines: TradePreviewLine[] = [], subOrder: any[] = []; let freight = 0;
  for (const group of value.settlement_item) {
    if (!Array.isArray(group.product_list) || !group.product_list.length || group.product_list.length > 50) throw new Error('结算商品分组无效');
    freight += tradeAmount(group.deliver_fee ?? 0, '结算运费');
    for (const row of group.product_list) {
      const inventoryId = tradeId(row.inventory_id, '结算库存池'), skuCode = tradeId(row.sku_code, '结算规格');
      const key = inventoryId + ':' + skuCode, selection = expected.get(key);
      if (!selection || seen.has(key) || String(row.spu_code) !== selection.detail.productCode || row.is_valid !== true || Number(row.product_type) !== selection.detail.productType) throw new Error('结算商品与指定规格不一致或商品已失效');
      if (row.offline_store_delivery_type === 2 || row.offline_store_delivery_type === 3) throw new Error('该商品需要选择自提门店或专用配送方式');
      const quantity = tradeAmount(row.purchase_num, '结算数量'), price = tradeAmount(row.price, '结算价格'), stock = amountOrNull(row.stock_num);
      if (!Number.isInteger(quantity) || quantity !== selection.item.quantity || (stock !== null && quantity > stock)) throw new Error('结算数量变化或库存不足');
      if (row.address_id != null && String(row.address_id) !== address.id) throw new Error('结算返回了不同配送地址');
      const products: any[] = [];
      if (selection.detail.productType === 2) {
        if (!Array.isArray(row.settlement_item_package_item_list) || row.settlement_item_package_item_list.length !== selection.detail.packageItems.length) throw new Error('组合结算明细缺失');
        const replacements = new Map((selection.item.packageReplacements ?? []).map(item => [item.originalSku, item.skuCode]));
        const children = new Map(selection.detail.packageItems.map(item => [item.productCode, item]));
        for (const child of row.settlement_item_package_item_list) {
          const productCode = tradeId(child.spu_code, '组合子商品'), original = children.get(productCode);
          if (!original || String(child.sku_code) !== (replacements.get(original.originalSku) ?? original.originalSku) || child.item_num !== original.quantity) throw new Error('组合结算规格发生变化');
          children.delete(productCode);
          products.push({ product_code: productCode, sku_code: String(child.sku_code), sku_price: tradeAmount(child.price, '组合价格'), purchase_num: quantity, inventory_id: inventoryId, package_spu_code: selection.detail.productCode, item_num: original.quantity, ...(row.package_instance_id ? { package_instance_id: tradeId(row.package_instance_id, '组合实例') } : {}) });
        }
      } else products.push({ product_code: selection.detail.productCode, sku_code: skuCode, sku_price: price, purchase_num: quantity, inventory_id: inventoryId, address_id: address.id, remark });
      subOrder.push({ remark, products }); seen.add(key);
      lines.push({ productCode: selection.detail.productCode, skuCode, name: text(row.product_title) || selection.detail.name, specification: text(row.sku_name) || selection.item.skuCode, quantity, price, inventoryId });
    }
  }
  if (seen.size !== expected.size || (details.every(row=>row.productType===1)&&lines.reduce((sum, row) => sum + row.quantity, 0) !== pieces)) throw new Error('结算未完整覆盖所选商品');
  const itemTotal = lines.reduce((sum, row) => sum + row.price * row.quantity, 0);
  if (Math.abs(itemTotal - deduction) > 1e-6 && Math.abs(itemTotal + freight - deduction) > 1e-6) throw new Error('官网结算合计与明细不一致');
  lines.sort((a,b)=>a.inventoryId.localeCompare(b.inventoryId)||a.skuCode.localeCompare(b.skuCode));
  for(const order of subOrder)order.products.sort((a:any,b:any)=>String(a.product_code).localeCompare(String(b.product_code))||String(a.sku_code).localeCompare(String(b.sku_code)));
  subOrder.sort((a,b)=>String(a.products[0].inventory_id).localeCompare(String(b.products[0].inventory_id))||String(a.products[0].sku_code).localeCompare(String(b.products[0].sku_code)));
  return { lines, deduction, pieces, freight, payload: { address_id: address.id, multi_address_type: '', group_code: '', is_cart_exchange: 2, sub_order: subOrder } };
}
