import type { OfficialAddress } from './types';

export interface TradeReference { productId: string; sourceId: string; quantity: number; }
export interface TradeSelection extends TradeReference { skuCode: string; packageReplacements?: { originalSku: string; skuCode: string }[]; }
export interface TradeSku { code: string; label: string; price: number | null; stock: number | null; limit: number | null; properties: { name: string; value: string }[]; }
export interface TradePackageItem { productCode: string; name: string; quantity: number; originalSku: string; skus: TradeSku[]; }
export interface TradeProduct {
  productId: string; sourceId: string; cardId: string; productCode: string; inventoryId: string;
  name: string; image: string; type: number; productType: number; skus: TradeSku[]; packageItems: TradePackageItem[];
  description: string; stock: number | null;
}
export interface TradeContext { cardId: string; products: TradeProduct[]; addresses: OfficialAddress[]; previewOnly: boolean; }
export interface TradePreviewInput { cardId: string; addressId: string; items: TradeSelection[]; remark?: string; }
export interface TradePreviewLine { productCode: string; skuCode: string; name: string; specification: string; quantity: number; price: number; inventoryId: string; }
export interface TradePreview {
  id: string; digest: string; cardId: string; address: OfficialAddress; lines: TradePreviewLine[];
  deduction: number; pieces: number; balance: number; balanceUnit: string; balanceMode: 'balance' | 'selection-limit'; remaining: number | null; freight: number;
  agreements: { name: string; url: string; content: string }[]; expiresAt: string; previewOnly: boolean;
}
export type TradeAttemptStatus = 'submitting' | 'submitted' | 'succeeded' | 'rejected' | 'unknown' | 'closed' | 'partial';
export function needsTradeReconciliation(status:TradeAttemptStatus):boolean{return ['submitting','submitted','unknown'].includes(status);}
export interface TradeAttempt {
  id: string; cardId: string; cardKey: string; fingerprint: string; previewDigest: string;
  status: TradeAttemptStatus; startedAt: string; updatedAt: string; deduction: number; balanceUnit: string;
  lines: TradePreviewLine[]; orderCode: string | null; sellerOrderCode: string | null;
  message: string; baselineOrders: string[];
}
export interface TradeSubmitInput { previewId: string; digest: string; confirmDeduction: boolean; acceptAgreements: boolean; }
export interface TradeAttemptView extends Omit<TradeAttempt, 'cardKey' | 'fingerprint' | 'previewDigest' | 'baselineOrders'> {}

const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 500 && !/[\r\n\0]/.test(value);
export function validateTradeReferences(cardId: unknown, items: unknown): asserts items is TradeReference[] {
  if (!id(cardId) || !Array.isArray(items) || !items.length || items.length > 50) throw new Error('下单卡片或商品数量无效');
  const sources = new Set<string>();
  for (const item of items) {
    if (!item || !id(item.productId) || !id(item.sourceId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 || sources.has(item.sourceId)) throw new Error('下单商品、数量或重复来源无效');
    sources.add(item.sourceId);
  }
}
export function validateTradePreview(value: unknown): asserts value is TradePreviewInput {
  const data = value as TradePreviewInput;
  if (!data || typeof data !== 'object') throw new Error('结算参数无效');
  validateTradeReferences(data.cardId, data.items);
  if (!id(data.addressId) || (data.remark !== undefined && (typeof data.remark !== 'string' || data.remark.length > 200 || /\0/.test(data.remark)))) throw new Error('结算地址或备注无效');
  for (const item of data.items) {
    if (!id(item.skuCode)) throw new Error('请选择完整商品规格');
    if (item.packageReplacements !== undefined && (!Array.isArray(item.packageReplacements) || item.packageReplacements.length > 50 || item.packageReplacements.some(row => !row || !id(row.originalSku) || !id(row.skuCode)))) throw new Error('组合商品规格无效');
  }
}
export function validateTradeSubmit(value: unknown): asserts value is TradeSubmitInput {
  const data = value as TradeSubmitInput;
  if (!data || !id(data.previewId) || typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest) || data.confirmDeduction !== true || typeof data.acceptAgreements !== 'boolean') throw new Error('请确认本卡扣减与结算内容后再提交订单');
}
