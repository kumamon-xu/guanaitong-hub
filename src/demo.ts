import type { AppState, HubAPI, Product, LocalAddress } from './shared/types';

const DEMO_KEY = 'guanaitong-hub-demo-v2';
const now = '2026-10-02T11:20:00.000Z';
const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const base64ToBytes = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
async function demoBackupKey(passphrase: string, salt: Uint8Array) {
  if (passphrase.length < 8) throw new Error('备份密码至少需要 8 个字符');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 210000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function isDemoState(value: unknown): value is AppState {
  const data = value as AppState;
  return !!data && Array.isArray(data.cards) && data.cards.every(card => typeof card.number === 'string' && card.number.startsWith('DEMO') && typeof card.id === 'string') && Array.isArray(data.products) && data.products.every(product => typeof product.id === 'string' && typeof product.name === 'string' && Array.isArray(product.offers)) && Array.isArray(data.cart) && Array.isArray(data.orders) && Array.isArray(data.activities) && !!data.settings;
}

const productArt = (kind: string, bg: string) => {
  const drawings: Record<string, string> = {
    pot: '<ellipse cx="140" cy="175" rx="69" ry="10" fill="#000" opacity=".07"/><path d="M80 112h120v42c0 22-26 28-60 28s-60-6-60-28z" fill="#334448"/><path d="M83 109q57-24 114 0" fill="#476064"/><ellipse cx="140" cy="108" rx="60" ry="9" fill="#7b8e8d"/><path d="M133 89h14v15h-14z" fill="#263a3e"/><path d="M80 123H62v22h20M200 123h18v22h-18" fill="none" stroke="#334448" stroke-width="9"/>',
    oil: '<ellipse cx="140" cy="178" rx="48" ry="8" fill="#000" opacity=".05"/><path d="M101 85q1-12 14-16h51q13 4 13 16v82q0 10-12 10h-54q-12 0-12-10z" fill="#e9ba4b"/><path d="M117 66h46v15h-46z" fill="#af4334"/><path d="M167 96h17v31h-9" fill="none" stroke="#d2a839" stroke-width="8"/><rect x="105" y="113" width="70" height="40" rx="3" fill="#fff4d2"/><path d="M124 125h30M129 135h22" stroke="#848d42" stroke-width="4"/><path d="M112 89v16" stroke="#fff" opacity=".4" stroke-width="6"/>',
    rice: '<ellipse cx="140" cy="181" rx="53" ry="7" fill="#000" opacity=".06"/><path d="M96 73h88l8 96q-48 15-104 0z" fill="#e4d2b4"/><path d="M97 76h85l2 21H95z" fill="#56785e"/><path d="M97 131h88l4 34q-47 13-98 0z" fill="#a85137"/><path d="M127 115q13-24 26 0" fill="none" stroke="#56785e" stroke-width="3"/><path d="M141 103v25m0-14-11-8m11 15 12-10" stroke="#56785e" stroke-width="2"/><path d="M107 145h66" stroke="#f6ead3" stroke-width="4"/>',
    coffee: '<ellipse cx="140" cy="176" rx="63" ry="8" fill="#000" opacity=".06"/><path d="M86 83h50v87H86z" fill="#836447"/><path d="M142 74h51v96h-51z" fill="#324b40"/><path d="M85 83h52v15H85zM141 74h53v15h-53z" fill="#273f35"/><rect x="90" y="112" width="41" height="38" fill="#e9d9bc"/><rect x="146" y="105" width="42" height="39" fill="#e9d9bc"/><ellipse cx="110" cy="130" rx="7" ry="11" fill="#806444"/><path d="M110 119q-5 12 0 22" stroke="#e9d9bc" fill="none"/><ellipse cx="167" cy="123" rx="7" ry="11" fill="#806444"/>',
    cup: '<ellipse cx="140" cy="183" rx="47" ry="7" fill="#000" opacity=".06"/><path d="M111 78h58l-4 98h-50z" fill="#d9ded5"/><path d="M110 77q30-11 60 0v14h-60z" fill="#789288"/><path d="M122 107v54" stroke="#fff" opacity=".55" stroke-width="5"/><rect x="132" y="119" width="18" height="5" rx="2" fill="#7b978e"/>',
    towels: '<ellipse cx="140" cy="184" rx="72" ry="8" fill="#000" opacity=".06"/><path d="M75 130h126v40H75z" fill="#d4c4b0"/><path d="M82 105h121v30H82z" fill="#f1e8db"/><path d="M74 82h117v26H74z" fill="#a7b7a9"/><path d="M84 145h111m-113 9h111M83 94h100M91 120h105" stroke="#fff" opacity=".25" stroke-width="2"/>',
  };
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 230"><rect width="280" height="230" rx="16" fill="${bg}"/>${drawings[kind] || drawings.cup}</svg>`)}`;
};

const sampleProducts: Product[] = [
  { id: 'demo-p1', name: '苏泊尔精铁无涂层炒锅', brand: '苏泊尔', category: '厨房用具', specification: '32cm · 燃气灶适用', image: productArt('pot', '#e7ece7'), mergeKey: 'demo-pot', favorite: true, offers: [{ cardId: 'demo-c1', sourceId: 'demo-offer-1', price: 189, priceUnit: '元', stock: 20, url: '', variant: '32cm', syncedAt: now }, { cardId: 'demo-c2', sourceId: 'demo-offer-2', price: 179, priceUnit: '元', stock: 8, url: '', variant: '32cm', syncedAt: now }] },
  { id: 'demo-p2', name: '金龙鱼非转基因玉米油', brand: '金龙鱼', category: '粮油食品', specification: '5L · 家庭装', image: productArt('oil', '#f5edd9'), mergeKey: 'demo-oil', favorite: false, offers: [{ cardId: 'demo-c1', sourceId: 'demo-offer-3', price: 89, priceUnit: '元', stock: 42, url: '', variant: '5L', syncedAt: now }, { cardId: 'demo-c2', sourceId: 'demo-offer-4', price: 89, priceUnit: '元', stock: 12, url: '', variant: '5L', syncedAt: now }] },
  { id: 'demo-p3', name: '五常稻花香大米', brand: '十月稻田', category: '粮油食品', specification: '5kg · 真空包装', image: productArt('rice', '#f0eadd'), mergeKey: 'demo-rice', favorite: false, offers: [{ cardId: 'demo-c1', sourceId: 'demo-offer-5', price: 69, priceUnit: '元', stock: 35, url: '', variant: '5kg', syncedAt: now }] },
  { id: 'demo-p4', name: '精选挂耳咖啡礼盒', brand: '隅田川', category: '饮料冲调', specification: '20包 · 两种风味', image: productArt('coffee', '#e8ede4'), mergeKey: 'demo-coffee', favorite: true, offers: [{ cardId: 'demo-c2', sourceId: 'demo-offer-6', price: 79, priceUnit: '元', stock: 23, url: '', variant: '20包', syncedAt: now }] },
  { id: 'demo-p5', name: '轻量不锈钢保温杯', brand: '膳魔师', category: '杯壶水具', specification: '500ml · 雾灰绿', image: productArt('cup', '#e9ede7'), mergeKey: 'demo-cup', favorite: false, offers: [{ cardId: 'demo-c1', sourceId: 'demo-offer-7', price: 159, priceUnit: '元', stock: 10, url: '', variant: '灰绿 500ml', syncedAt: now }, { cardId: 'demo-c2', sourceId: 'demo-offer-8', price: 149, priceUnit: '元', stock: 6, url: '', variant: '灰绿 500ml', syncedAt: now }] },
  { id: 'demo-p6', name: '新疆棉柔软毛巾三件套', brand: '洁丽雅', category: '家纺日用', specification: '3条装 · 自然色系', image: productArt('towels', '#f2e8df'), mergeKey: 'demo-towels', favorite: false, offers: [{ cardId: 'demo-c2', sourceId: 'demo-offer-9', price: 49, priceUnit: '元', stock: 60, url: '', variant: '3条装', syncedAt: now }] },
].map(product => ({ ...product, categories: [product.category], offers: product.offers.map(offer => ({ ...offer, categories: [product.category] })) }));

export const createDemoState = (): AppState => ({
  version: 1,
  cards: [
    { id: 'demo-c1', number: 'DEMO00000101', label: '秋日福利卡', status: 'active', balance: 328, balanceUnit: '元', expiresAt: '2027-06-30', syncedAt: now, addedAt: now, archived: false, note: '这是一张用于预览的虚拟卡片', error: null, productCount: 4, hasPassword: false },
    { id: 'demo-c2', number: 'DEMO00000202', label: '节日礼享卡', status: 'active', balance: 500, balanceUnit: '元', expiresAt: '2027-01-31', syncedAt: now, addedAt: now, archived: false, note: '这是一张用于预览的虚拟卡片', error: null, productCount: 5, hasPassword: false },
    { id: 'demo-c3', number: 'DEMO00000303', label: '往期福利卡', status: 'exhausted', balance: 0, balanceUnit: '元', expiresAt: '2026-09-30', syncedAt: now, addedAt: now, archived: true, note: '余额已用完，已在本地归档', error: null, productCount: 0, hasPassword: false },
  ],
  products: sampleProducts,
  orders: [{ id: 'demo-order-1', cardId: 'demo-c1', sourceId: 'DEMO2026100101', name: '生活用品兑换订单', status: '已完成', amount: 120, createdAt: '2026-10-01T04:00:00.000Z', tracking: '演示订单，无真实物流', url: '' }],
  cart: [],
  activities: [{ id: 'a1', at: now, type: 'success', message: '示例商品已整理：9 个报价合并为 6 件商品' }, { id: 'a2', at: '2026-10-02T11:18:00.000Z', type: 'info', message: '往期福利卡余额已用完，在本地自动归档', cardId: 'demo-c3' }],
  settings: { autoArchive: true, maskNumbers: true, autoLogin: false },
});

export function createDemoAPI(): HubAPI {
  let addresses: LocalAddress[] = [];
  let state: AppState;
  try { const stored = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null'); state = isDemoState(stored) ? stored : createDemoState(); } catch { state = createDemoState(); }
  const listeners = new Set<(next: AppState) => void>();
  const save = () => { localStorage.setItem(DEMO_KEY, JSON.stringify(state)); const next = structuredClone(state); listeners.forEach(fn => fn(next)); return next; };
  const blocked = async (): Promise<void> => { throw new Error('浏览器演示模式无法操作官网。请在桌面应用中登录和同步真实卡片。'); };
  return {
    getAddresses: async () => structuredClone(addresses),
    saveAddress: async (draft,id) => {
      if (!/^1[3-9]\d{9}$/.test(draft.phone) || !draft.recipient.trim() || !draft.province || !draft.city || !draft.district || !draft.detail.trim()) throw new Error('请填写完整的演示收货地址');
      const existing=addresses.find(a=>a.id===id);const now=new Date().toISOString();
      const address={...draft,id:existing?.id||crypto.randomUUID(),isDefault:existing?.isDefault??!addresses.length,createdAt:existing?.createdAt||now,updatedAt:now};
      addresses=existing?addresses.map(a=>a.id===id?address:a):[...addresses,address];return structuredClone(address);
    },
    setDefaultAddress: async id => {addresses=addresses.map(a=>({...a,isDefault:a.id===id}));return structuredClone(addresses);},
    removeAddress: async id => {addresses=addresses.filter(a=>a.id!==id);if(addresses.length&&!addresses.some(a=>a.isDefault))addresses[0].isDefault=true;return structuredClone(addresses);},
    exportAddresses: async () => {await blocked();return false;},
    importAddresses: async () => {await blocked();return null;},
    getAddressRegions: async parentId => parentId ? [{id:'990101001',name:'示例街道',children:null}] : [{id:'990000',name:'演示省',children:[{id:'990100',name:'演示市',children:[{id:'990101',name:'演示区',children:null}]}]}],
    getOfficialAddresses: async () => {await blocked();return [];},
    publishAddress: async () => {await blocked();throw new Error('演示模式');},
    getState: async () => structuredClone(state),
    getViewState:async()=>structuredClone(viewState(state)),
    queryProducts:async query=>queryProductsInMemory(state,query),
    getProduct:async id=>{const product=state.products.find(item=>item.id===id);if(!product)throw new Error('商品不存在');return structuredClone(product);},
    queryOrders:async query=>queryOrdersInMemory(state,query),
    exportOrders:async()=>{await blocked();return false;},
    getSyncTasks:async()=>[],cancelSync:async()=>{},retryFailedSync:async()=>[],onSyncTasks:()=>()=>{},
    getPriceHistory:async()=>[],checkUpdates:async()=>{await blocked();throw new Error('演示模式');},openUpdate:blocked,prepareUpdate:async()=>{await blocked();throw new Error('演示模式');},cancelUpdate:blocked,installUpdate:blocked,onUpdateProgress:()=>()=>{},
    addCards: async inputs => { state.cards.push(...inputs.map((input, index) => ({ id: `demo-added-${Date.now()}-${index}`, number: input.number, label: input.label || `演示卡 ${state.cards.length + index + 1}`, status: 'pending' as const, balance: null, balanceUnit: '元', expiresAt: null, syncedAt: null, addedAt: new Date().toISOString(), archived: false, note: '演示卡片；不会连接官网或保存密码', error: null, productCount: 0, hasPassword: false }))); return save(); },
    updateCard: async (id, patch) => { state.cards = state.cards.map(card => card.id === id ? { ...card, ...patch } : card); return save(); },
    openCard: blocked,
    openProduct: blocked,
    syncCard: async () => { await blocked(); throw new Error('演示模式'); },
    syncAll: async () => { await blocked(); return []; },
    favoriteProduct: async id => { state.products = state.products.map(product => product.id === id ? { ...product, favorite: !product.favorite } : product); return save(); },
    mergeProducts: async ids => {
      const products = state.products.filter(product => ids.includes(product.id));
      if (products.length < 2) throw new Error('至少选择两件商品');
      const first = products[0]; const offerKeys = new Set<string>();
      first.offers = products.flatMap(product => product.offers).filter(offer => { const key = `${offer.cardId}:${offer.sourceId}`; if (offerKeys.has(key)) return false; offerKeys.add(key); return true; });
      first.categories = [...new Set(products.flatMap(product => product.categories?.length ? product.categories : [product.category]).filter(Boolean))];
      first.favorite = products.some(product => product.favorite);
      state.cart = state.cart.map(item => ids.includes(item.productId) ? { ...item, productId: first.id } : item);
      state.products = state.products.filter(product => !ids.includes(product.id) || product.id === first.id);
      return save();
    },
    addToCart: async (productId, cardId, quantity, sourceId) => {
      const product = state.products.find(product => product.id === productId); const offer = product?.offers.find(offer => offer.cardId === cardId && (!sourceId || offer.sourceId === sourceId));
      if (!offer) throw new Error('所选卡片没有该商品报价');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('数量必须为 1 到 99 的整数');
      const existing = state.cart.find(item => item.productId === productId && item.cardId === cardId && item.sourceId === offer.sourceId);
      if (existing && existing.quantity + quantity > Math.min(99, offer.stock ?? 99)) throw new Error('兑换数量超过库存或单项上限');
      if (quantity > (offer.stock ?? 99)) throw new Error('兑换数量超过库存');
      if (existing) existing.quantity += quantity; else state.cart.push({ id: `cart-${Date.now()}`, productId, cardId, sourceId: offer.sourceId, quantity });
      return save();
    },
    updateCart: async (id, quantity) => { state.cart = quantity <= 0 ? state.cart.filter(item => item.id !== id) : state.cart.map(item => item.id === id ? { ...item, quantity } : item); return save(); },
    checkout: blocked,
    updateSettings: async settings => { state.settings = { ...state.settings, ...settings }; return save(); },
    exportData: async passphrase => {
      const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await demoBackupKey(passphrase, salt);
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(state)));
      const envelope = { format: 'guanaitong-hub-demo-backup', version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = '关爱通卡管家-演示加密备份.json'; anchor.click(); URL.revokeObjectURL(url); return true;
    },
    importData: async passphrase => new Promise<AppState | null>((resolve, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0]; if (!file) { resolve(null); return; }
        try {
          const envelope = JSON.parse(await file.text());
          if (envelope.format !== 'guanaitong-hub-demo-backup' || envelope.version !== 1 || !envelope.salt || !envelope.iv || !envelope.data) throw new Error('演示模式仅支持演示备份，真实备份请在桌面应用导入');
          const key = await demoBackupKey(passphrase, base64ToBytes(envelope.salt));
          let decrypted: ArrayBuffer;
          try { decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) as BufferSource }, key, base64ToBytes(envelope.data) as BufferSource); }
          catch { throw new Error('备份密码错误，或文件已损坏'); }
          const imported = JSON.parse(new TextDecoder().decode(decrypted));
          if (!isDemoState(imported)) throw new Error('演示备份内容无效');
          state = imported; resolve(save());
        } catch (error) { reject(error); }
      };
      input.oncancel = () => resolve(null); input.click();
    }),
    openDataFolder: blocked,
    exportDiagnostics: async () => { await blocked(); return false; },
    onState: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
}
import { queryProductsInMemory,queryOrdersInMemory } from './shared/queries';
import { viewState } from './shared/operations';
