import { createHash, randomUUID } from 'node:crypto';
import { normalizeCard } from './adapter';
import { redactText } from './redaction';
import type { HubStore } from './store';
import { TradeBusinessError, type TradeTransport } from './trade-client';
import { normalizeSettlement, normalizeTradeProduct, sourceIdentity, tradeAmount, tradeId, validateTradeAddresses, verifySelection } from './trade-protocol';
import { needsTradeReconciliation, validateTradePreview, validateTradeReferences, validateTradeSubmit, type TradeAttempt, type TradeAttemptView, type TradeContext, type TradePreview, type TradePreviewInput, type TradeProduct, type TradeReference, type TradeSubmitInput } from '../src/shared/trade';
import type { OfficialAddress } from '../src/shared/types';

export interface TradeLedger {
  list(): TradeAttempt[];
  put(attempt: TradeAttempt): Promise<void>;
}
interface Options {
  store: HubStore; transport: TradeTransport; ledger: TradeLedger;
  ensureLoggedIn(cardId: string): Promise<boolean>;
  updated?(cardId: string): Promise<void>;
  previewOnly?: boolean; now?: () => number;
}
interface Prepared { input: TradePreviewInput; preview: TradePreview; payload: Record<string, unknown>; cardKey: string; }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerKey = (number: string) => hash(['card', number]);
function visible(attempt: TradeAttempt): TradeAttemptView {
  const { cardKey: _cardKey, fingerprint: _fingerprint, previewDigest: _digest, baselineOrders: _baseline, ...view } = attempt;
  return structuredClone(view);
}
function agreements(common: any): TradePreview['agreements'] {
  const setting = common.current_info?.word_show_setting ?? common.mall_info?.word_show_setting ?? common.word_show_setting;
  if (!setting?.confirm_order_agreement_name) return [];
  const name = String(setting.confirm_order_agreement_name).slice(0, 200), value = String(setting.confirm_order_agreement_content ?? '');
  if (value.length > 50000) throw new Error('商品协议内容过大');
  let url = '', content = value.replace(/<[^>]*>/g, ' ').trim();
  if (/^https:\/\//.test(value)) {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !(parsed.hostname === 'guanaitong.com' || parsed.hostname.endsWith('.guanaitong.com'))) throw new Error('商品协议来源不受支持');
    url = parsed.toString(); content = '';
  }
  if (!url && !content) throw new Error('商品协议内容缺失，请重新读取结算');
  return [{ name, url, content }];
}
export class TradeService {
  private readonly previews = new Map<string, Prepared>();
  private readonly submitting = new Map<string, Promise<TradeAttemptView>>();
  private readonly consumed = new Map<string, string>();
  private readonly cardsInFlight = new Set<string>();
  constructor(private readonly options: Options) {}
  get busy(): boolean { return this.cardsInFlight.size > 0; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  invalidatePreviews(): void { this.previews.clear(); }
  agreementURL(id:string,index:number):string{
    const preview=this.previews.get(id)?.preview;
    if(!preview||Date.parse(preview.expiresAt)<=this.now()||!Number.isInteger(index)||index<0||index>=preview.agreements.length)throw new Error('协议预览已过期');
    const value=preview.agreements[index].url;if(!value)throw new Error('该协议已在结算页面显示正文');
    const url=new URL(value);
    if(!/\.(pdf|docx?)$/i.test(url.pathname)&&url.pathname!=='/festival_exchange/mine/description')throw new Error('协议文档地址不受支持');
    return value;
  }
  private async identity(cardId: string, forTrade = true): Promise<any> {
    const card = this.options.store.getCard(cardId);
    if (forTrade && card.archived) throw new Error('该卡已归档，不能兑换');
    if (!await this.options.ensureLoggedIn(cardId)) throw new Error('请先完成当前卡片登录后结算');
    const current = await this.options.transport.request(cardId, 'common/getCurrentInfo');
    const metadata = normalizeCard(current, card);
    if (forTrade && (metadata.status !== 'active' || current.is_usable !== 1)) throw new Error('当前卡片已过期、不可用或额度已用完');
    tradeAmount(current.balance, '当前卡片余额');
    if (![1, 2].includes(current.limited_type)) throw new Error('当前卡片兑换额度类型未知');
    return current;
  }
  private async addresses(cardId: string, number: string): Promise<OfficialAddress[]> {
    const result: OfficialAddress[] = [], seen = new Set<string>(); let total: number | undefined;
    for (let page = 1; page <= 20; page++) {
      const data = await this.options.transport.request(cardId, 'address/list', { page, rows_per_page: 50 });
      const rows = validateTradeAddresses(data, number);
      if (data.total_count != null) { const count = tradeAmount(data.total_count, '地址数量'); if (!Number.isInteger(count) || (total !== undefined && count !== total)) throw new Error('地址列表发生变化'); total = count; }
      for (const row of rows) { if (seen.has(row.id)) throw new Error('官网地址分页重复'); seen.add(row.id); result.push(row); }
      if (data.has_next === false || (data.has_next == null && (total !== undefined ? result.length >= total : rows.length < 50))) {
        if (total !== undefined && result.length !== total) throw new Error('官网地址列表不完整'); return result;
      }
      if (!rows.length) break;
    }
    throw new Error('官网地址读取未完成');
  }
  private async history(cardId:string,number:string):Promise<any[]>{
    const rows:any[]=[],seen=new Set<string>();let total:number|undefined;
    for(let page=1;page<=100;page++){
      const data=await this.options.transport.request(cardId,'exchangeOrder/list',{card_code:number,page,rows_per_page:100});
      if(!Array.isArray(data.data_list)||data.data_list.length>1000)throw new Error('订单查询响应无效');
      if(data.total_count!=null){const value=tradeAmount(data.total_count,'订单数量');if(!Number.isInteger(value)||(total!==undefined&&value!==total))throw new Error('订单数量发生变化，请稍后核对');total=value;}
      for(const row of data.data_list){
        if(row.card_code!=null&&String(row.card_code)!==number)throw new Error('订单查询返回其他卡片信息');
        const key=tradeId(row.shop_order_code,'官网订单')+':'+(row.seller_order_code==null?'':tradeId(row.seller_order_code,'商家订单'));
        if(seen.has(key))throw new Error('官网订单分页重复');seen.add(key);rows.push(row);
      }
      if(data.has_next===false||(data.has_next==null&&(total!==undefined?rows.length>=total:data.data_list.length<100))){if(total!==undefined&&rows.length!==total)throw new Error('订单列表不完整');return rows;}
      if(!data.data_list.length)break;
    }
    throw new Error('订单分页尚未完整读取，暂不确认扣卡结果');
  }
  private async details(cardId: string, items: TradeReference[]): Promise<{ products: TradeProduct[]; raw: any[] }> {
    const products: TradeProduct[] = [], raw: any[] = [];
    for (const item of items) {
      const product = this.options.store.getProduct(item.productId);
      const offer = product.offers.find(offer => offer.cardId === cardId && offer.sourceId === item.sourceId);
      if (!offer || offer.stock === 0) throw new Error('所选商品不属于该卡或已经失效');
      const data = await this.options.transport.request(cardId, 'product/detail', sourceIdentity(offer));
      products.push(normalizeTradeProduct(data, item.productId, offer)); raw.push(data);
    }
    return { products, raw };
  }
  async context(cardId: string, items: TradeReference[]): Promise<TradeContext> {
    validateTradeReferences(cardId, items);
    const current = await this.identity(cardId);
    const [common, details, addresses] = await Promise.all([
      this.options.transport.request(cardId, 'common/getCommonInfo'), this.details(cardId, items), this.addresses(cardId, String(current.card_code)),
    ]);
    if (!['1', 1].includes(common.current_user_info?.post_address_type)) throw new Error('该卡需要专用配送地址，不能使用普通地址结算');
    await this.identity(cardId);
    return { cardId, products: details.products, addresses, previewOnly: !!this.options.previewOnly };
  }
  private async prepare(input: TradePreviewInput): Promise<Prepared> {
    validateTradePreview(input);
    const card = this.options.store.getCard(input.cardId), current = await this.identity(input.cardId);
    const [common, details, addresses] = await Promise.all([
      this.options.transport.request(input.cardId, 'common/getCommonInfo'), this.details(input.cardId, input.items), this.addresses(input.cardId, card.number),
    ]);
    if (!['1', 1].includes(common.current_user_info?.post_address_type)) throw new Error('该卡需要专用配送地址，不能使用普通地址结算');
    const address = addresses.find(row => row.id === input.addressId); if (!address) throw new Error('地址不属于当前卡片或已删除');
    const types = new Set(details.products.map(row => row.type)); if (types.size !== 1) throw new Error('不同配送类型的商品请分开结算');
    input.items.forEach((item, index) => verifySelection(details.products[index], item));
    const skuCodes = input.items.flatMap((item, index) => details.products[index].productType === 1 ? [item.skuCode] : details.products[index].packageItems.map(row => item.packageReplacements?.find(replacement => replacement.originalSku === row.originalSku)?.skuCode ?? row.originalSku));
    const check = await this.options.transport.request(input.cardId, 'product/check', { address_id: address.id, sku_code_str: skuCodes.join(',') });
    if (check.result !== true) throw new Error('所选商品无法配送至当前地址或规格不可兑换');
    if (details.products[0].type === 2) {
      const products = input.items.map((item, index) => ({ product_code: details.products[index].productCode, sku_code: item.skuCode, sku_price: verifySelection(details.products[index], item).price, purchase_num: item.quantity, inventory_id: details.products[index].inventoryId }));
      const risk = await this.options.transport.request(input.cardId, 'exchangeOrder/riskValidate', { sub_order: [{ products }] });
      if (typeof risk === 'string' ? risk.trim() : risk?.risk_message || risk?.message || risk?.result === false) throw new Error('官网风控要求未满足，本次未提交订单');
    }
    const settlement = await this.options.transport.request(input.cardId, 'cart/getSettlementInfo', {
      address_id: address.id, is_cart: 2, type: details.products[0].type,
      settlement_info_obj_list: input.items.map((item, index) => ({ is_multi_card: details.raw[index].is_multi_card, inventory_id: details.products[index].inventoryId, sku_code: item.skuCode, purchase_num: item.quantity, ...(item.packageReplacements?.length ? { package_replaced_list: item.packageReplacements.map(row => ({ ori_sku_code: row.originalSku, sku_code: row.skuCode })) } : {}) })),
    });
    const result = normalizeSettlement(settlement, input.items, details.products, address, input.remark ?? '');
    if (details.products[0].type === 2) {
      delete result.payload.address_id; Object.assign(result.payload, { receiver_name: address.draft.recipient, receiver_mobile: address.draft.phone });
    }
    const final = await this.identity(input.cardId);
    if (String(final.card_code) !== card.number || final.limited_type !== current.limited_type) throw new Error('结算期间卡片身份或额度类型发生变化');
    const balance = tradeAmount(final.balance, '卡片余额'), balanceMode = final.limited_type === 1 ? 'balance' as const : 'selection-limit' as const;
    if (balanceMode === 'balance' && result.deduction > balance + 1e-8) throw new Error('当前卡片余额不足');
    const agreementList = agreements(common);
    const canonical = { card: ownerKey(card.number), address, payload: result.payload, lines: result.lines, deduction: result.deduction, pieces: result.pieces, freight: result.freight, balance, balanceMode, agreements: agreementList };
    const preview: TradePreview = { id: randomUUID(), digest: hash(canonical), cardId: input.cardId, address, lines: result.lines, deduction: result.deduction, pieces: result.pieces, freight: result.freight, balance, balanceUnit: balanceMode === 'balance' ? '额度' : '单次任选额度', balanceMode, remaining: balanceMode === 'balance' ? balance - result.deduction : null, agreements: agreementList, expiresAt: new Date(this.now() + 120000).toISOString(), previewOnly: !!this.options.previewOnly };
    return { input: structuredClone(input), preview, payload: result.payload, cardKey: ownerKey(card.number) };
  }
  async preview(input: TradePreviewInput): Promise<TradePreview> {
    const prepared = await this.prepare(input);
    for (const [id, old] of this.previews) if (Date.parse(old.preview.expiresAt) < this.now()) this.previews.delete(id);
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(prepared.preview.id, prepared); return structuredClone(prepared.preview);
  }
  attempts(): TradeAttemptView[] {
    const cards = new Map(this.options.store.getState().cards.map(card => [ownerKey(card.number), card.id]));
    const rows=this.options.ledger.list().filter(row=>cards.has(row.cardKey)).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||a.id.localeCompare(b.id));
    // Pending writes must remain accessible even when unrelated cards have long histories.
    const selected=[...rows.filter(row=>needsTradeReconciliation(row.status)),...rows.filter(row=>!needsTradeReconciliation(row.status)).slice(0,100)];
    return selected.map(row=>visible({...row,cardId:cards.get(row.cardKey)!}));
  }
  async recover(): Promise<void> {
    for (const row of this.options.ledger.list()) if (row.status === 'submitting') await this.options.ledger.put({ ...row, status: 'unknown', updatedAt: new Date(this.now()).toISOString(), message: '程序中断，订单结果待核对，不能自动重新提交' });
  }
  async submit(input: TradeSubmitInput): Promise<TradeAttemptView> {
    validateTradeSubmit(input);
    if (this.options.previewOnly) throw new Error('真实测试仅允许结算预览，最终下单已禁用');
    const previous = this.consumed.get(input.previewId);
    if (previous) { const attempt=this.options.ledger.list().find(row=>row.id===previous);if(!attempt||attempt.previewDigest!==input.digest)throw new Error('已使用的结算确认不一致');return visible(attempt); }
    const pending = this.submitting.get(input.previewId); if (pending) return pending;
    const prepared = this.previews.get(input.previewId);
    if (!prepared || prepared.preview.digest !== input.digest || Date.parse(prepared.preview.expiresAt) <= this.now()) throw new Error('结算已过期或确认内容不一致，请重新预览');
    if (prepared.preview.agreements.length && !input.acceptAgreements) throw new Error('请阅读并接受商品协议');
    if (this.cardsInFlight.has(prepared.cardKey)) throw new Error('该卡正在提交订单，请等待结果');
    if (this.options.ledger.list().some(row => row.cardKey === prepared.cardKey && needsTradeReconciliation(row.status))) throw new Error('该卡有订单结果待核对，请先查询订单状态');
    this.cardsInFlight.add(prepared.cardKey);
    const work = this.performSubmit(input, prepared).finally(() => { this.cardsInFlight.delete(prepared.cardKey); this.submitting.delete(input.previewId); });
    this.submitting.set(input.previewId, work); return work;
  }
  private async performSubmit(input: TradeSubmitInput, prepared: Prepared): Promise<TradeAttemptView> {
    const fresh = await this.prepare(prepared.input);
    if (fresh.preview.digest !== input.digest) throw new Error('实时价格、地址、协议或卡片余额已变化，请重新预览确认');
    const baseline = await this.options.transport.request(prepared.input.cardId, 'exchangeOrder/list', { card_code: this.options.store.getCard(prepared.input.cardId).number, page: 1, rows_per_page: 100 });
    if (!Array.isArray(baseline.data_list)) throw new Error('提交前订单核对响应无效');
    const card = this.options.store.getCard(prepared.input.cardId);
    if(baseline.data_list.some((row:any)=>row.card_code!=null&&String(row.card_code)!==card.number))throw new Error('提交前订单列表属于其他卡片');
    const finalIdentity=await this.identity(prepared.input.cardId);
    if(tradeAmount(finalIdentity.balance,'当前余额')!==fresh.preview.balance||Date.parse(prepared.preview.expiresAt)<=this.now())throw new Error('提交前余额或结算有效期发生变化，请重新预览');
    let attempt: TradeAttempt = { id: randomUUID(), cardId: prepared.input.cardId, cardKey: prepared.cardKey, fingerprint: hash(prepared.input), previewDigest: input.digest, status: 'submitting', startedAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString(), deduction: fresh.preview.deduction, balanceUnit: fresh.preview.balanceUnit, lines: fresh.preview.lines, orderCode: null, sellerOrderCode: null, message: '正在提交扣卡兑换', baselineOrders: baseline.data_list.map((row: any) => tradeId(row.shop_order_code, '既有订单')) };
    await this.options.ledger.put(attempt);
    this.consumed.set(input.previewId, attempt.id); this.previews.delete(input.previewId);
    try {
      const value = await this.options.transport.exchange(attempt.cardId, fresh.payload);
      if (value.shop_order_code) attempt.orderCode = tradeId(value.shop_order_code, '新订单');
      if (value.seller_order_code) attempt.sellerOrderCode = tradeId(value.seller_order_code, '商家订单');
      if (!attempt.orderCode || value.cashier_url) throw new Error(value.cashier_url ? '官网返回了额外支付分支，未执行任何支付，请核对订单状态' : '官网未返回可核对的订单号');
      attempt = { ...attempt, status: 'submitted', message: '订单已生成，正在核对扣卡结果', updatedAt: new Date(this.now()).toISOString() };
      await this.options.ledger.put(attempt);
    } catch (error) {
      const card = this.options.store.getCard(attempt.cardId);
      attempt = { ...attempt, status: error instanceof TradeBusinessError ? 'rejected' : 'unknown', message: redactText(error instanceof Error ? error.message : '订单结果待核对', [card.number, this.options.store.getPassword(card.id)]), updatedAt: new Date(this.now()).toISOString() };
      await this.options.ledger.put(attempt); return visible(attempt);
    }
    try{return await this.query(attempt.id);}catch{attempt={...attempt,message:'订单已生成，当前未能核对扣卡结果，请稍后查询',updatedAt:new Date(this.now()).toISOString()};await this.options.ledger.put(attempt);return visible(attempt);}
  }
  async query(id: string): Promise<TradeAttemptView> {
    let attempt = this.options.ledger.list().find(row => row.id === id); if (!attempt) throw new Error('找不到本地兑换记录');
    const card = this.options.store.getState().cards.find(card => ownerKey(card.number) === attempt!.cardKey); if (!card) throw new Error('原卡片尚未恢复，不能查询该订单');
    if (this.cardsInFlight.has(attempt.cardKey) && attempt.status === 'submitting') throw new Error('该订单仍在提交，请等待结果');
    await this.identity(card.id, false);
    if (!attempt.orderCode) {
      // Order-list absence cannot prove a timed-out write failed. Never release this lock automatically.
      const rows = await this.options.transport.request(card.id, 'exchangeOrder/list', { card_code: card.number, page: 1, rows_per_page: 100 });
      if (!Array.isArray(rows.data_list)) throw new Error('订单查询响应无效');
      return visible({ ...attempt, cardId: card.id, message: attempt.status === 'rejected' ? attempt.message : '未取得确定订单号，请核对订单记录；系统不会重新提交或扣款' });
    }
    if (['succeeded','rejected','closed','partial'].includes(attempt.status)) return visible({ ...attempt, cardId: card.id });
    try {
      try{await this.options.transport.request(card.id, 'exchangeOrder/getPaymentResult', { shop_order_code: attempt.orderCode, ...(attempt.sellerOrderCode ? { seller_order_code: attempt.sellerOrderCode } : {}) });}catch{/* The historical order is an independent read-back when payment-result polling is unavailable. */}
      const rows = await this.history(card.id,card.number);
      const matches = rows.filter((row: any) => String(row.shop_order_code) === attempt!.orderCode);
      if(matches.some((row:any)=>row.card_code!=null&&String(row.card_code)!==card.number))throw new Error('订单查询返回其他卡片信息');
      await this.identity(card.id,false);
      const paid=(row:any)=>[2,4,5,999].includes(row.trade_status)||(row.trade_status===3&&!!row.time_order_payed);
      const closed=(row:any)=>row.trade_status===6||(row.trade_status===3&&!row.time_order_payed);
      if(matches.length&&matches.every(paid))attempt={...attempt,status:'succeeded',message:'扣卡兑换已确认成功'};
      else if(matches.length&&matches.every(closed))attempt={...attempt,status:'closed',message:'订单已关闭，请核对本卡额度与返还结果'};
      else if(matches.length&&matches.every((row:any)=>paid(row)||closed(row)))attempt={...attempt,status:'partial',message:'部分商家订单已兑换，部分已关闭，请核对额度与商品明细'};
      else attempt = { ...attempt, status: 'submitted', message: matches.length ? '订单已生成，部分扣卡结果尚待确认' : '订单列表尚未返回该订单，请稍后查询' };
      attempt.updatedAt = new Date(this.now()).toISOString(); await this.options.ledger.put(attempt);
      if (['succeeded','closed','partial'].includes(attempt.status)) { try { await this.options.updated?.(card.id); } catch { /* Confirmed order is retained when local synchronization fails. */ } }
    } catch { attempt = { ...attempt, message: '订单已生成，暂未能核对扣卡结果，请稍后查询', updatedAt: new Date(this.now()).toISOString() }; await this.options.ledger.put(attempt); }
    return visible({ ...attempt, cardId: card.id });
  }
}
