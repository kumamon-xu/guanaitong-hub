import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import { LegacyHubRepository } from './legacy-storage';
import type { Credential, PortableData, HubRepository } from './persistence';
import { validateAddresses, type LocalAddress } from './addresses';
import { redactText } from './redaction';
import { viewState, type ManagementData } from '../src/shared/operations';
import { validateManagement } from './management-data';
import { unitKey } from '../src/shared/units';
import type { Activity, AddCardInput, AppState, Card, CartItem, Order, Product, ProductOffer } from '../src/shared/types';

export interface StoreOptions {
  repository?: HubRepository;
  directory: string;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
  now?: () => Date;
  lightweightResults?:boolean;
}
export interface CardSnapshot {
  card?: Partial<Omit<Card, 'id' | 'number' | 'hasPassword' | 'addedAt'>>;
  products?: Product[];
  orders?: Order[];
  activity?: { message: string; type: Activity['type'] };
}
export interface CartQuote {
  items: CartItem[];
  total: number | null;
  unit: string | null;
  warnings: string[];
}
const MAX_BACKUP_SIZE = 32 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const normalized = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
const offerKey = (offer: Pick<ProductOffer, 'cardId' | 'sourceId'>) => JSON.stringify([offer.cardId, offer.sourceId]);
export const blankState = (): AppState => ({ cards: [], products: [], orders: [], cart: [], activities: [], settings: { autoArchive: true, maskNumbers: true, autoLogin: false }, version: 1 });
function fail(message: string): never { throw new Error(message); }
function finiteOrNull(value: unknown, field: string, integer = false): asserts value is number | null {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value)))) fail(`${field}必须是非负${integer ? '整数' : '数值'}或未知值`);
}
function boundedString(value: unknown, field: string, max = 2000, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) fail(`${field}格式无效`);
}
function validCredential(value: unknown): asserts value is Credential {
  const credential = value as Credential;
  if (!credential || typeof credential !== 'object' || typeof credential.number !== 'string' || !/^\d{6,32}$/.test(credential.number)) fail('卡号须为 6 至 32 位数字');
  if (typeof credential.password !== 'string' || credential.password.length < 1 || credential.password.length > 128 || /[\r\n\0]/.test(credential.password)) fail('密码须为 1 至 128 个字符且不能含换行');
}
function validQuantity(quantity: number, allowZero = false): void {
  if (!Number.isInteger(quantity) || quantity < (allowZero ? 0 : 1) || quantity > 99) fail('数量须为 1 至 99 的整数；移除商品请设为 0');
}
function expiresAtMillis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999+08:00` : value);
  return Number.isFinite(parsed) ? parsed : null;
}
function sameVerifiedProduct(a: Product, b: Product): boolean {
  return !!a.mergeKey.trim() && a.mergeKey === b.mergeKey && normalized(a.name) === normalized(b.name) && normalized(a.brand) === normalized(b.brand) && normalized(a.specification) === normalized(b.specification);
}
function validateCategories(value: unknown): void {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>40)fail('商品分类格式无效');
  for(const name of value)boundedString(name,'分类名称',200,true);
}
function validateProduct(product: Product, knownCards: Set<string>): void {
  if (!product || typeof product !== 'object') fail('商品格式无效');
  boundedString(product.id, '商品 ID', 200, true);
  boundedString(product.name, '商品名称', 1000, true);
  for (const key of ['brand', 'image', 'category', 'specification', 'mergeKey'] as const) boundedString(product[key], `商品 ${key}`, 4000);
  validateCategories(product.categories);
  if (typeof product.favorite !== 'boolean' || !Array.isArray(product.offers) || product.offers.length > 10000) fail('商品报价格式无效');
  const identities = new Set<string>();
  for (const offer of product.offers) {
    if (!offer || !knownCards.has(offer.cardId)) fail('商品报价引用了不存在的卡片');
    boundedString(offer.sourceId, '官网商品 ID', 500, true);
    for (const key of ['priceUnit', 'url', 'variant', 'syncedAt'] as const) boundedString(offer[key], `报价 ${key}`, 4000);
    finiteOrNull(offer.price, '商品价格');
    finiteOrNull(offer.stock, '库存', true);
    validateCategories(offer.categories);
    const key = offerKey(offer);
    if (identities.has(key)) fail('商品中有重复报价');
    identities.add(key);
  }
}
function validateOrder(order: Order, knownCards: Set<string>): void {
  if (!order || !knownCards.has(order.cardId)) fail('订单引用了不存在的卡片');
  for (const key of ['id', 'sourceId', 'name', 'status', 'createdAt', 'tracking', 'url'] as const) boundedString(order[key], `订单 ${key}`, 4000, key === 'id' || key === 'sourceId');
  finiteOrNull(order.amount, '订单金额');
}
function cleanProduct(product: Product): Product {
  return { id: product.id, name: product.name, brand: product.brand, image: product.image, category: product.category, ...(product.categories?{categories:[...new Set(product.categories)]}:{}), specification: product.specification, mergeKey: product.mergeKey, favorite: product.favorite,
    offers: product.offers.map(offer => ({ cardId: offer.cardId, sourceId: offer.sourceId, price: offer.price, priceUnit: offer.priceUnit, stock: offer.stock, url: offer.url, variant: offer.variant, syncedAt: offer.syncedAt, ...(offer.categories?{categories:[...new Set(offer.categories)]}:{}) })) };
}
function cleanOrder(order: Order): Order {
  return { id: order.id, cardId: order.cardId, sourceId: order.sourceId, name: order.name, status: order.status, amount: order.amount, createdAt: order.createdAt, tracking: order.tracking, url: order.url };
}
export function validatePortable(value: unknown): PortableData {
  const data = value as PortableData;
  if (!data || typeof data !== 'object' || !data.state || !data.credentials || !data.manualMerges || Array.isArray(data.credentials) || Array.isArray(data.manualMerges)) fail('数据文件格式无效');
  const state = data.state;
  if (state.version !== 1 || !Array.isArray(state.cards) || !Array.isArray(state.products) || !Array.isArray(state.orders) || !Array.isArray(state.cart) || !Array.isArray(state.activities)) fail('数据文件版本或结构不受支持');
  if (state.cards.length > 10000 || state.products.length > 100000 || state.orders.length > 100000 || state.cart.length > 10000 || state.activities.length > 10000) fail('数据文件内容过大');
  if (!state.settings || typeof state.settings.autoArchive !== 'boolean' || typeof state.settings.maskNumbers !== 'boolean') fail('设置格式无效');
  if(state.settings.autoLogin!==undefined&&typeof state.settings.autoLogin!=='boolean')fail('自动登录设置格式无效');
  const cardIds = new Set<string>();
  const numbers = new Set<string>();
  for (const card of state.cards) {
    boundedString(card.id, '卡片 ID', 200, true);
    if (cardIds.has(card.id)) fail('数据中有重复卡片 ID');
    cardIds.add(card.id);
    const credential = Object.hasOwn(data.credentials, card.id) ? data.credentials[card.id] : undefined;
    validCredential(credential);
    if (card.number !== credential.number || numbers.has(card.number)) fail('卡片凭据不一致或卡号重复');
    numbers.add(card.number);
    if (!['pending', 'active', 'expired', 'exhausted', 'error'].includes(card.status)) fail('卡片状态格式无效');
    for (const key of ['label', 'balanceUnit', 'addedAt', 'note'] as const) boundedString(card[key], `卡片 ${key}`, 4000);
    for (const key of ['expiresAt', 'syncedAt', 'error'] as const) if (card[key] !== null) boundedString(card[key], `卡片 ${key}`, 4000);
    if (card.expiresAt !== null && expiresAtMillis(card.expiresAt) === null) fail('卡片到期日期格式无效');
    finiteOrNull(card.balance, '卡片余额');
    finiteOrNull(card.productCount, '商品数量', true);
    if (typeof card.archived !== 'boolean' || typeof card.hasPassword !== 'boolean') fail('卡片标记格式无效');
    card.hasPassword = true;
  }
  if (Object.keys(data.credentials).some(id => !cardIds.has(id))) fail('存在无主的卡片凭据');
  const productIds = new Set<string>();
  const allOffers = new Set<string>();
  for (const product of state.products) {
    validateProduct(product, cardIds);
    if (productIds.has(product.id)) fail('商品 ID 重复');
    productIds.add(product.id);
    for (const offer of product.offers) {
      const key = offerKey(offer);
      if (allOffers.has(key)) fail('同一卡片商品重复归属');
      allOffers.add(key);
    }
  }
  const orderIds = new Set<string>();
  for (const order of state.orders) {
    validateOrder(order, cardIds);
    if (orderIds.has(order.id)) fail('订单 ID 重复');
    orderIds.add(order.id);
  }
  const cartIds = new Set<string>();
  for (const item of state.cart) {
    boundedString(item.id, '购物清单 ID', 200, true);
    if (cartIds.has(item.id) || !cardIds.has(item.cardId) || !productIds.has(item.productId)) fail('购物清单引用无效');
    boundedString(item.sourceId, '购物清单商品 ID', 500, true);
    validQuantity(item.quantity);
    cartIds.add(item.id);
  }
  for (const activity of state.activities) {
    boundedString(activity.id, '活动 ID', 200, true);
    boundedString(activity.at, '活动日期', 200);
    boundedString(activity.message, '活动说明', 4000);
    if (!['success', 'warning', 'info'].includes(activity.type) || (activity.cardId !== undefined && !cardIds.has(activity.cardId))) fail('活动记录格式无效');
  }
  for (const [key, target] of Object.entries(data.manualMerges)) {
    if (key.length > 2000 || typeof target !== 'string' || !productIds.has(target)) fail('商品合并记录格式无效');
  }
  // Keep only the public schema; unknown imported/source fields must never reach the UI.
  return {
    state: {
      cards: state.cards.map(card => ({ id: card.id, number: card.number, label: card.label, status: card.status, balance: card.balance, balanceUnit: card.balanceUnit, expiresAt: card.expiresAt, syncedAt: card.syncedAt, addedAt: card.addedAt, archived: card.archived, note: card.note, error: card.error, productCount: card.productCount, hasPassword: true, ...(card.tags===undefined?{}:{tags:validateTags(card.tags)}) })),
      products: state.products.map(cleanProduct), orders: state.orders.map(cleanOrder),
      cart: state.cart.map(item => ({ id: item.id, productId: item.productId, cardId: item.cardId, sourceId: item.sourceId, quantity: item.quantity })),
      activities: state.activities.map(activity => ({ id: activity.id, at: activity.at, type: activity.type, message: activity.message, ...(activity.cardId ? { cardId: activity.cardId } : {}) })),
      settings: cleanSettings(state.settings), version: 1,
    },
    credentials: Object.fromEntries(Object.entries(data.credentials).map(([id, credential]) => [id, { number: credential.number, password: credential.password }])),
    manualMerges: Object.fromEntries(Object.entries(data.manualMerges)),
  };
}
function validateTags(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>20)fail('每张卡最多 20 个标签');
  return [...new Set(value.map(tag=>{boundedString(tag,'标签',40,true);return tag.trim();}))];
}
function cleanSettings(value:AppState['settings']):AppState['settings']{
  const result:AppState['settings']={autoArchive:value.autoArchive,maskNumbers:value.maskNumbers,autoLogin:value.autoLogin??false};
  if(value.syncConcurrency!==undefined){if(!Number.isInteger(value.syncConcurrency)||value.syncConcurrency<1||value.syncConcurrency>3)fail('同步并发须为 1 至 3');result.syncConcurrency=value.syncConcurrency;}
  if(value.expiryReminderDays!==undefined){if(!Number.isInteger(value.expiryReminderDays)||value.expiryReminderDays<1||value.expiryReminderDays>90)fail('到期提醒须为 1 至 90 天');result.expiryReminderDays=value.expiryReminderDays;}
  if(value.updateFeed!==undefined){boundedString(value.updateFeed,'更新地址',2000);if(value.updateFeed){const url=new URL(value.updateFeed);if(url.protocol!=='https:'||url.username||url.password||url.hash)fail('更新地址须为不含账户信息的 HTTPS 地址');}result.updateFeed=value.updateFeed;}
  return result;
}

/** Local-only data; credentials are encrypted by the host OS via injected safeStorage. */
export class HubStore {
  readonly directory: string;
  readonly filePath: string;
  private state = blankState();
  private credentials: Record<string, Credential> = {};
  private manualMerges: Record<string, string> = {};
  private readonly options: StoreOptions;
  private readonly repository: HubRepository;
  constructor(options: StoreOptions) {
    this.options = options;
    this.directory = resolve(options.directory);
    this.repository = options.repository ?? new LegacyHubRepository(options);
    this.filePath = this.repository.filePath;
    const loaded = this.repository.loadHub();
    if (loaded) {
      const data = validatePortable(loaded);
      this.state = data.state;
      this.credentials = data.credentials;
      this.manualMerges = data.manualMerges;
    } else this.persist(this.state, this.credentials, this.manualMerges);
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private persist(state: AppState, credentials: Record<string, Credential>, manualMerges: Record<string, string>): void {
    this.repository.saveHub({ state, credentials, manualMerges });
  }
  private commit(state: AppState, credentials = this.credentials, manualMerges = this.manualMerges): AppState {
    this.persist(state, credentials, manualMerges);
    this.state = state;
    this.credentials = credentials;
    this.manualMerges = manualMerges;
    return this.options.lightweightResults?this.getViewState():this.getState();
  }
  private card(id: string, state = this.state): Card {
    return state.cards.find(card => card.id === id) ?? fail('找不到该卡片');
  }
  private orderableCard(id: string): Card {
    const card = this.card(id);
    if (card.archived) fail('此卡已归档，不能下单');
    const expiration = expiresAtMillis(card.expiresAt);
    if (card.status === 'expired' || (expiration !== null && expiration < Date.parse(this.now()))) fail('此卡已过期，不能下单');
    if (card.status === 'exhausted' || card.balance === 0) fail('此卡余额或兑换次数已用完，不能下单');
    if (card.status !== 'active') fail('请先登录并同步此卡，再添加兑换商品');
    return card;
  }
  private activity(state: AppState, message: string, type: Activity['type'], cardId?: string): void {
    boundedString(message, '活动说明', 4000, true);
    message = redactText(message, Object.values(this.credentials).flatMap(item => [item.number, item.password]));
    state.activities.unshift({ id: randomUUID(), at: this.now(), type, message, ...(cardId ? { cardId } : {}) });
    state.activities = state.activities.slice(0, 300);
  }
  private recount(state: AppState): void {
    for(const product of state.products){
      const categories=[...new Set(product.offers.flatMap(offer=>offer.categories??[]))];
      if(product.offers.length){product.categories=categories;product.category=categories[0]??'未分类';}
    }
    for (const card of state.cards) card.productCount = state.products.filter(product => product.offers.some(offer => offer.cardId === card.id)).length;
  }
  getState(): AppState { return clone(this.state); }
  getViewState():AppState{return clone(viewState(this.state));}
  getProduct(id:string):Product{return clone(this.state.products.find(item=>item.id===id)??fail('找不到该商品'));}
  getCard(id:string):Card{return clone(this.card(id));}
  refresh(): AppState {
    const data = validatePortable(this.repository.loadHub());
    this.state = data.state; this.credentials = data.credentials; this.manualMerges = data.manualMerges;
    return this.getState();
  }
  getPassword(id: string): string {
    this.card(id);
    return this.credentials[id]?.password ?? fail('此卡未保存密码');
  }
  addCards(inputs: AddCardInput[]): AppState {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 1000) fail('请提供 1 至 1000 张卡片');
    const numbers = new Set(this.state.cards.map(card => card.number));
    const normalizedInputs = inputs.map(input => {
      if (!input || typeof input.number !== 'string') fail('卡号格式无效');
      const credential = { number: input.number.trim(), password: input.password };
      validCredential(credential);
      if (numbers.has(credential.number)) fail('发现重复卡号，本批次未导入，请先去除重复项');
      numbers.add(credential.number);
      if (input.label !== undefined) boundedString(input.label, '卡片名称', 200);
      return { ...credential, label: input.label?.trim() ?? '' };
    });
    const state = this.getState();
    const credentials = clone(this.credentials);
    for (const input of normalizedInputs) {
      const id = randomUUID();
      credentials[id] = { number: input.number, password: input.password };
      state.cards.push({ id, number: input.number, label: input.label || `卡片 ${state.cards.length + 1}`, status: 'pending', balance: null, balanceUnit: '', expiresAt: null, syncedAt: null, addedAt: this.now(), archived: false, note: '', error: null, productCount: 0, hasPassword: true });
    }
    this.activity(state, `已添加 ${inputs.length} 张卡片，等待官网登录同步`, 'success');
    return this.commit(state, credentials);
  }
  updateCard(id: string, patch: Partial<Pick<Card, 'label' | 'note' | 'archived' | 'tags'>>): AppState {
    const state = this.getState();
    const card = this.card(id, state);
    if (!patch || typeof patch !== 'object') fail('卡片修改格式无效');
    if (patch.label !== undefined) { boundedString(patch.label, '卡片名称', 200); card.label = patch.label.trim(); }
    if (patch.note !== undefined) { boundedString(patch.note, '备注', 4000); card.note = patch.note; }
    if(patch.tags!==undefined)card.tags=validateTags(patch.tags);
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== 'boolean') fail('归档标记格式无效');
      card.archived = patch.archived;
    }
    return this.commit(state);
  }
  updateSettings(patch: Partial<AppState['settings']>): AppState {
    if (!patch || typeof patch !== 'object') fail('设置格式无效');
    const state = this.getState();
    for (const key of ['autoArchive', 'maskNumbers', 'autoLogin'] as const) if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') fail('设置须为布尔值');
      state.settings[key] = patch[key]!;
    }
    state.settings=cleanSettings({...state.settings,...patch});
    if (state.settings.autoArchive) for (const card of state.cards) if (card.balance === 0) card.archived = true;
    return this.commit(state);
  }
  favoriteProduct(id: string): AppState {
    const state = this.getState();
    const product = state.products.find(product => product.id === id) ?? fail('找不到该商品');
    product.favorite = !product.favorite;
    return this.commit(state);
  }
  mergeProducts(ids: string[]): AppState {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length < 2) fail('请选择至少两件不同商品合并');
    const state = this.getState();
    const selected = ids.map(id => state.products.find(product => product.id === id) ?? fail('找不到待合并商品'));
    const target = selected[0];
    const mergedIds = new Set(ids.slice(1));
    const manualMerges = clone(this.manualMerges);
    const offers = new Map<string, ProductOffer>();
    for (const product of selected) for (const offer of product.offers) { offers.set(offerKey(offer), offer); manualMerges[offerKey(offer)] = target.id; }
    for (const [key, id] of Object.entries(manualMerges)) if (mergedIds.has(id)) manualMerges[key] = target.id;
    target.offers = [...offers.values()];
    target.favorite = selected.some(product => product.favorite);
    state.products = state.products.filter(product => !mergedIds.has(product.id));
    for (const item of state.cart) if (mergedIds.has(item.productId)) item.productId = target.id;
    // Combining existing cart rows must still obey the per-offer limit.
    const cart = new Map<string, CartItem>();
    for (const item of state.cart) {
      const key = offerKey(item);
      const existing = cart.get(key);
      if (existing) { existing.quantity += item.quantity; validQuantity(existing.quantity); }
      else cart.set(key, item);
    }
    state.cart = [...cart.values()];
    this.recount(state);
    this.activity(state, `已合并 ${ids.length} 件商品；下次同步保留合并关系`, 'success');
    return this.commit(state, this.credentials, manualMerges);
  }
  applySnapshot(id: string, snapshot: CardSnapshot): AppState {
    const state = this.getState();
    const card = this.card(id, state);
    const metadata = snapshot.card;
    if (metadata) {
      if (metadata.balance !== undefined) { finiteOrNull(metadata.balance, '卡片余额'); card.balance = metadata.balance; }
      for (const key of ['balanceUnit', 'label', 'note'] as const) if (metadata[key] !== undefined) { boundedString(metadata[key], `卡片 ${key}`, 4000); card[key] = metadata[key]!; }
      if (metadata.expiresAt !== undefined) {
        if (metadata.expiresAt !== null && (typeof metadata.expiresAt !== 'string' || expiresAtMillis(metadata.expiresAt) === null)) fail('卡片到期日期格式无效');
        card.expiresAt = metadata.expiresAt;
      }
      if (metadata.error !== undefined) { if (metadata.error !== null) boundedString(metadata.error, '同步错误', 4000); card.error = metadata.error; }
      if (metadata.status !== undefined) {
        if (!['pending', 'active', 'expired', 'exhausted', 'error'].includes(metadata.status)) fail('卡片状态格式无效');
        card.status = metadata.status;
      }
      if (metadata.archived !== undefined) { if (typeof metadata.archived !== 'boolean') fail('归档标记格式无效'); card.archived = metadata.archived; }
    }
    if(snapshot.products!==undefined||snapshot.orders!==undefined||metadata?.balance!==undefined||metadata?.syncedAt!==undefined)card.syncedAt=this.now();
    const expiration = expiresAtMillis(card.expiresAt);
    if (expiration !== null && expiration < Date.parse(this.now())) card.status = 'expired';
    else if (card.balance === 0) { card.status = 'exhausted'; if (state.settings.autoArchive) card.archived = true; }
    else if (card.status === 'exhausted' && card.balance !== null && card.balance > 0) card.status = 'active';
    if (snapshot.products !== undefined) {
      if (!Array.isArray(snapshot.products)) fail('商品快照格式无效');
      const knownCards = new Set(state.cards.map(card => card.id));
      const incoming = clone(snapshot.products);
      const seen = new Set<string>();
      for (const product of incoming) {
        validateProduct(product, knownCards);
        for (const offer of product.offers) {
          if (offer.cardId !== id) fail('同步快照中包含其他卡片的报价');
          const key = offerKey(offer);
          if (seen.has(key)) fail('同步快照包含重复官网商品');
          seen.add(key);
        }
      }
      const previous = new Map<string, Product>();
      const previousOffers = new Map<string,ProductOffer>();
      for (const product of state.products) for (const offer of product.offers) if (offer.cardId === id) previous.set(offerKey(offer), product);
      for(const product of state.products)for(const offer of product.offers)if(offer.cardId===id)previousOffers.set(offerKey(offer),clone(offer));
      for (const product of state.products) product.offers = product.offers.filter(offer => offer.cardId !== id);
      for (const rawSource of incoming) {
        const source = cleanProduct(rawSource);
        let sourceTarget: Product | undefined;
        for (const offer of source.offers) {
        const key = offerKey(offer);
        const old = previous.get(key);
        if(offer.categories===undefined){const previousOffer=previousOffers.get(key);if(previousOffer?.categories)offer.categories=clone(previousOffer.categories);}
        const manualId = this.manualMerges[key];
        let target = manualId ? state.products.find(product => product.id === manualId) : undefined;
        if (!target && !manualId && sourceTarget) target = sourceTarget;
        if (!target) target = state.products.find(product => sameVerifiedProduct(product, source));
        if (!target && old && (!old.offers.length || sameVerifiedProduct(old, source))) target = state.products.find(product => product.id === old.id);
        if (!target) {
          target = { ...source, id: state.products.some(product => product.id === source.id) ? randomUUID() : source.id, offers: [], favorite: old?.favorite ?? false };
          state.products.push(target);
        } else if (!manualId && !target.offers.length) {
          Object.assign(target, { name: source.name, brand: source.brand, image: source.image, category: source.category, specification: source.specification, mergeKey: source.mergeKey });
        }
        target.favorite = target.favorite || !!old?.favorite;
        target.offers.push(offer);
        sourceTarget ??= target;
        for (const item of state.cart) if (item.cardId === id && item.sourceId === offer.sourceId) item.productId = target.id;
        }
      }
      const retainedManualIds = new Set(Object.values(this.manualMerges));
      const retainedCartIds = new Set(state.cart.map(item => item.productId));
      state.products = state.products.filter(product => product.offers.length || product.favorite || retainedManualIds.has(product.id) || retainedCartIds.has(product.id));
      this.recount(state);
    }
    if (snapshot.orders !== undefined) {
      if (!Array.isArray(snapshot.orders)) fail('订单快照格式无效');
      const knownCards = new Set(state.cards.map(card => card.id));
      const orders = clone(snapshot.orders);
      const otherIds = new Set(state.orders.filter(order => order.cardId !== id).map(order => order.id));
      const seenIds = new Set<string>();
      const seenSources = new Set<string>();
      for (const order of orders) {
        validateOrder(order, knownCards);
        if (order.cardId !== id || seenSources.has(order.sourceId)) fail('订单快照包含其他卡片或重复订单');
        seenSources.add(order.sourceId);
        if (otherIds.has(order.id) || seenIds.has(order.id)) order.id = `${id}:${order.sourceId}`;
        if (seenIds.has(order.id) || otherIds.has(order.id)) fail('订单标识冲突');
        seenIds.add(order.id);
      }
      state.orders = [...state.orders.filter(order => order.cardId !== id), ...orders.map(cleanOrder)];
    }
    if (snapshot.activity) {
      if (!['success', 'warning', 'info'].includes(snapshot.activity.type)) fail('活动类型格式无效');
      this.activity(state, snapshot.activity.message, snapshot.activity.type, id);
    }
    return this.commit(state);
  }
  addToCart(productId: string, cardId: string, quantity: number, sourceId?: string): AppState {
    validQuantity(quantity);
    this.orderableCard(cardId);
    const state = this.getState();
    const product = state.products.find(product => product.id === productId) ?? fail('找不到该商品');
    if (sourceId !== undefined) boundedString(sourceId, '官网商品 ID', 500, true);
    const offers = product.offers.filter(offer => offer.cardId === cardId && (sourceId === undefined || offer.sourceId === sourceId));
    if (!offers.length) fail('此卡没有该商品的报价');
    if (offers.length > 1) fail('此卡包含多个官网商品报价，请选择具体报价后加入清单');
    const offer = offers[0];
    if (offer.stock !== null && offer.stock < quantity) fail('商品库存不足');
    const existing = state.cart.find(item => item.productId === productId && item.cardId === cardId && item.sourceId === offer.sourceId);
    const totalQuantity = (existing?.quantity ?? 0) + quantity;
    validQuantity(totalQuantity);
    if (offer.stock !== null && totalQuantity > offer.stock) fail('商品库存不足');
    if (existing) existing.quantity = totalQuantity;
    else state.cart.push({ id: randomUUID(), productId, cardId, sourceId: offer.sourceId, quantity });
    // Validate the whole card allocation before committing.
    this.quoteFromState(cardId, state);
    return this.commit(state);
  }
  updateCart(id: string, quantity: number): AppState {
    validQuantity(quantity, true);
    const state = this.getState();
    const item = state.cart.find(item => item.id === id) ?? fail('找不到该清单项');
    if (quantity === 0) state.cart = state.cart.filter(item => item.id !== id);
    else {
      this.orderableCard(item.cardId);
      item.quantity = quantity;
      this.quoteFromState(item.cardId, state);
    }
    return this.commit(state);
  }
  private quoteFromState(cardId: string, state: AppState): CartQuote {
    const card = this.orderableCard(cardId);
    const items = state.cart.filter(item => item.cardId === cardId);
    const warnings = new Set<string>();
    const units = new Map<string, string>();
    const knownTotals = new Map<string, number>();
    let total = 0;
    let allKnown = true;
    for (const item of items) {
      validQuantity(item.quantity);
      const product = state.products.find(product => product.id === item.productId) ?? fail('清单中的商品已失效，请移除后重新添加');
      const offer = product.offers.find(offer => offer.cardId === cardId && offer.sourceId === item.sourceId) ?? fail('清单中的报价已失效，请重新同步或移除该商品');
      if (offer.stock !== null && item.quantity > offer.stock) fail(`“${product.name}”库存不足`);
      if (offer.stock === null) warnings.add('部分商品库存未知，需在官网确认');
      if (offer.price === null || !offer.priceUnit.trim()) { allKnown = false; warnings.add('部分商品兑换价格未知，需在官网确认'); }
      else {
        const amount = offer.price * item.quantity, key = unitKey(offer.priceUnit);
        total += amount; units.set(key, offer.priceUnit);
        knownTotals.set(key, (knownTotals.get(key) ?? 0) + amount);
      }
    }
    if (units.size > 1) { allKnown = false; warnings.add('清单包含不同计价单位，不能合计扣减余额'); }
    const [unit, displayUnit] = units.entries().next().value ?? [null, null];
    if (card.balance === null) warnings.add('卡片余额未知，需在官网确认');
    else if (items.length && unitKey(card.balanceUnit) === 'selection-limit') warnings.add('此卡额度为单次兑换上限，需在官网确认每次兑换和剩余次数');
    else {
      if ((knownTotals.get(unitKey(card.balanceUnit)) ?? 0) > card.balance + 1e-8) fail('此卡余额或兑换次数不足，请调整清单');
      if (items.length && unitKey(card.balanceUnit) === 'redemptions' && unit !== 'redemptions') warnings.add('此卡按兑换次数计数，商品金额不能直接扣减兑换次数');
      else if (items.length && unit && unitKey(card.balanceUnit) !== unit) warnings.add('卡片与商品计价单位不同，需在官网确认兑换条件');
    }
    return { items: clone(items), total: allKnown ? total : null, unit: units.size === 1 ? displayUnit : null, warnings: [...warnings] };
  }
  quoteCart(cardId: string): CartQuote { return this.quoteFromState(cardId, this.state); }
  addActivity(message: string, type: Activity['type'] = 'info', cardId?: string): AppState {
    if (!['success', 'warning', 'info'].includes(type)) fail('活动类型格式无效');
    if (cardId) this.card(cardId);
    const state = this.getState();
    this.activity(state, message, type, cardId);
    return this.commit(state);
  }
  exportBackup(passphrase: string, addresses?: LocalAddress[], management?:ManagementData): string {
    if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024) fail('备份口令须为 8 至 1024 个字符');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const version = management === undefined ? addresses === undefined ? 1 : 2 : 3;
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`guanaitong-hub-backup:${version}`));
      const payload = { state: this.state, credentials: this.credentials, manualMerges: this.manualMerges, ...(addresses === undefined ? {} : { addresses: validateAddresses(addresses), exportedAt: this.now() }),...(management===undefined?{}:{management:validateManagement(management,new Set(this.state.cards.map(card=>card.id)))}) };
      const plaintext = JSON.stringify(payload);
      if (Buffer.byteLength(plaintext, 'utf8') > 23 * 1024 * 1024) fail('备份内容过大，未导出');
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return JSON.stringify({ format: 'guanaitong-hub-backup', version, kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }, null, 2);
    } finally { key.fill(0); }
  }
  decodeBackup(contents: string, passphrase: string): { data: PortableData; addresses: LocalAddress[] | null; management:ManagementData|null; version: number; exportedAt: string | null } {
    if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_BACKUP_SIZE) fail('备份文件过大或格式无效');
    if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024) fail('备份口令须为 8 至 1024 个字符');
    let backup: { format: string; version: number; kdf: string; cipher: string; salt: string; iv: string; tag: string; data: string };
    try { backup = JSON.parse(contents); } catch { fail('备份文件不是有效 JSON'); }
    if (!backup! || backup!.format !== 'guanaitong-hub-backup' || ![1, 2, 3].includes(backup!.version) || backup!.kdf !== 'scrypt' || backup!.cipher !== 'aes-256-gcm') fail('备份格式或版本不受支持');
    for (const field of ['salt', 'iv', 'tag', 'data'] as const) if (typeof backup![field] !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(backup![field])) fail('备份加密数据格式无效');
    for (const field of ['salt', 'iv', 'tag', 'data'] as const) if (Buffer.from(backup![field], 'base64').toString('base64') !== backup![field]) fail('备份加密数据格式无效');
    const salt = Buffer.from(backup!.salt, 'base64');
    const iv = Buffer.from(backup!.iv, 'base64');
    const tag = Buffer.from(backup!.tag, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) fail('备份加密参数无效');
    const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    let plaintext: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`guanaitong-hub-backup:${backup!.version}`));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(Buffer.from(backup!.data, 'base64')), decipher.final()]).toString('utf8');
    } catch { fail('备份口令错误或文件已损坏，现有数据未改变'); }
    finally { key.fill(0); }
    let payload: PortableData & { addresses?: unknown; exportedAt?: unknown; management?:unknown };
    try { payload = JSON.parse(plaintext!); } catch { fail('备份内容格式无效，现有数据未改变'); }
    const data = validatePortable(payload);
    const addresses = backup!.version >= 2 ? validateAddresses(payload.addresses) : null;
    const management=backup!.version>=3?validateManagement(payload.management,new Set(data.state.cards.map(card=>card.id))):null;
    const exportedAt = typeof payload.exportedAt === 'string' && Number.isFinite(Date.parse(payload.exportedAt)) ? payload.exportedAt : null;
    return { data, addresses, management, version: backup!.version, exportedAt };
  }
  importBackup(contents: string, passphrase: string): AppState {
    const decoded = this.decodeBackup(contents, passphrase);
    if (decoded.addresses !== null) fail('统一备份请在设置与备份中恢复，以同时保存地址');
    const { data } = decoded;
    this.activity(data.state, '已从加密备份恢复本地数据', 'success');
    return this.commit(data.state, data.credentials, data.manualMerges);
  }
}
