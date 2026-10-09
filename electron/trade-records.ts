import type { TradeAttempt } from '../src/shared/trade';
import { needsTradeReconciliation } from '../src/shared/trade';
import { isDeepStrictEqual } from 'node:util';

export function validateTradeAttempts(value: unknown): TradeAttempt[] {
  if (!Array.isArray(value) || value.length > 20000) throw new Error('兑换记录数量无效');
  const ids = new Set<string>();
  const text = (value: unknown, max = 500) => typeof value === 'string' && !!value && value.length <= max && !/[\r\n\0]/.test(value);
  const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  return value.map(item => {
    if (!item || !text(item.id) || ids.has(item.id) || !text(item.cardId) || !digest(item.cardKey) || !digest(item.fingerprint) || !digest(item.previewDigest) || !['submitting', 'submitted', 'succeeded', 'rejected', 'unknown', 'closed', 'partial'].includes(item.status) || !text(item.startedAt) || !text(item.updatedAt) || !Number.isFinite(Date.parse(item.startedAt)) || !Number.isFinite(Date.parse(item.updatedAt)) || !amount(item.deduction) || !text(item.balanceUnit) || typeof item.message !== 'string' || item.message.length > 4000 || !Array.isArray(item.baselineOrders) || item.baselineOrders.length > 1000 || item.baselineOrders.some((id: unknown) => !text(id)) || (item.orderCode !== null && !text(item.orderCode)) || (item.sellerOrderCode !== null && !text(item.sellerOrderCode)) || !Array.isArray(item.lines) || !item.lines.length || item.lines.length > 50) throw new Error('兑换记录格式无效');
    ids.add(item.id);
    const lines = item.lines.map((line: any) => {
      if (!text(line.productCode) || !text(line.skuCode) || !text(line.inventoryId) || !text(line.name, 1000) || typeof line.specification !== 'string' || line.specification.length > 1000 || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99 || !amount(line.price)) throw new Error('兑换记录商品明细无效');
      return { productCode: line.productCode, skuCode: line.skuCode, inventoryId: line.inventoryId, name: line.name, specification: line.specification, quantity: line.quantity, price: line.price };
    });
    return { id: item.id, cardId: item.cardId, cardKey: item.cardKey, fingerprint: item.fingerprint, previewDigest: item.previewDigest, status: item.status, startedAt: item.startedAt, updatedAt: item.updatedAt, deduction: item.deduction, balanceUnit: item.balanceUnit, lines, orderCode: item.orderCode, sellerOrderCode: item.sellerOrderCode, message: item.message, baselineOrders: [...item.baselineOrders] };
  });
}

/** Restore adds evidence for the same intent; backup status alone cannot clear a pending write. */
export function mergeRestoredTradeAttempt(existing:TradeAttempt|undefined,incoming:TradeAttempt,restoredAt=new Date().toISOString()):TradeAttempt{
  const saved=validateTradeAttempts([incoming])[0];
  if(!existing)return saved.status==='submitting'?{...saved,status:'unknown',message:'恢复的提交记录结果待核对，不能自动重新提交',updatedAt:restoredAt}:saved;
  const current=validateTradeAttempts([existing])[0];
  const identity=(row:TradeAttempt)=>({id:row.id,cardKey:row.cardKey,fingerprint:row.fingerprint,previewDigest:row.previewDigest,startedAt:Date.parse(row.startedAt),deduction:row.deduction,balanceUnit:row.balanceUnit,lines:row.lines,baselineOrders:row.baselineOrders});
  if(!isDeepStrictEqual(identity(current),identity(saved)))throw new Error('同一兑换记录的卡片身份或交易内容冲突，恢复未完成');
  for(const key of ['orderCode','sellerOrderCode']as const)if(current[key]!==null&&saved[key]!==null&&current[key]!==saved[key])throw new Error('同一兑换记录的订单号冲突，恢复未完成');
  const merged={...current,orderCode:current.orderCode??saved.orderCode,sellerOrderCode:current.sellerOrderCode??saved.sellerOrderCode};
  const addedEvidence=merged.orderCode!==current.orderCode||merged.sellerOrderCode!==current.sellerOrderCode;
  // updatedAt may be a recent local recovery time, so it must not suppress older server references.
  if(addedEvidence&&(needsTradeReconciliation(current.status)||current.status==='rejected')){
    return{...merged,status:merged.orderCode?'submitted':'unknown',message:merged.orderCode?'恢复已补充订单号，请查询核对扣卡结果':'恢复已补充商家信息，仍需核对订单结果',updatedAt:restoredAt};
  }
  if(current.status==='submitting')return{...merged,status:'unknown',message:'恢复的提交记录结果待核对，不能自动重新提交',updatedAt:restoredAt};
  return merged;
}
