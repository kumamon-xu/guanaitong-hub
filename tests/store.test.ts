import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { HubStore, type StoreOptions } from '../electron/store';
import type { Product } from '../src/shared/types';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gat-store-test-'));
  directories.push(directory);
  const key = randomBytes(32);
  const options: StoreOptions = {
    directory,
    now: () => new Date('2026-10-02T04:00:00Z'),
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
  return { store: new HubStore(options), options, directory };
}
function cards(store: HubStore) {
  return store.addCards([{ number: '111111111111', password: 'fixture-password-one' }, { number: '222222222222', password: 'fixture-password-two' }]).cards;
}
function product(cardId: string, sourceId: string, overrides: Partial<Product> = {}, price = 10): Product {
  return { id: `${cardId}:${sourceId}`, name: '测试商品', brand: '测试品牌', specification: '500 g × 2', category: '食品', image: '', mergeKey: 'verified:sku-100:500gx2', favorite: false,
    offers: [{ cardId, sourceId, price, priceUnit: '元', stock: 20, url: 'https://a.guanaitong.com/example', variant: '原味', syncedAt: '2026-10-02T04:00:00Z' }], ...overrides };
}

test('credentials never reach disk or state in plaintext; atomic file has private permissions and can reopen', () => {
  const { store, options, directory } = fixture();
  const [first] = cards(store);
  const disk = readFileSync(store.filePath, 'utf8');
  assert.ok(!disk.includes('fixture-password-one'));
  assert.ok(!disk.includes('111111111111'));
  assert.ok(!JSON.stringify(store.getState()).includes('fixture-password'));
  // Windows uses ACLs instead of POSIX permission bits.
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(store.filePath).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(directory), ['state.json']);
  const reopened = new HubStore(options);
  assert.equal(reopened.getPassword(first.id), 'fixture-password-one');
  assert.equal(reopened.getState().cards[0].number, first.number);
  const snapshot = reopened.getState();
  snapshot.cards[0].label = 'outside mutation';
  assert.notEqual(reopened.getState().cards[0].label, 'outside mutation');
});

test('automatic login is opt-in, persists its setting, and safely migrates existing data',()=>{
  const {store,options}=fixture();
  assert.equal(store.getState().settings.autoLogin,false);
  assert.equal(store.updateSettings({autoLogin:true}).settings.autoLogin,true);
  assert.equal(new HubStore(options).getState().settings.autoLogin,true);
  assert.throws(()=>store.updateSettings({autoLogin:'yes' as unknown as boolean}));
  const legacy=JSON.parse(readFileSync(store.filePath,'utf8'));
  delete legacy.state.settings.autoLogin;
  writeFileSync(store.filePath,JSON.stringify(legacy));
  assert.equal(new HubStore(options).getState().settings.autoLogin,false);
});

test('invalid or duplicate batches are rejected without partial changes, including persistence failure', () => {
  const { store, options } = fixture();
  const before = readFileSync(store.filePath, 'utf8');
  assert.throws(() => store.addCards([{ number: '333333333333', password: 'valid' }, { number: '333333333333', password: 'duplicate' }]), /重复/);
  assert.equal(store.getState().cards.length, 0);
  assert.equal(readFileSync(store.filePath, 'utf8'), before);
  assert.throws(() => store.addCards([{ number: '123456', password: 'valid' }, { number: '', password: '' }]), /卡号/);
  assert.equal(store.getState().cards.length, 0);
  const failing = new HubStore({ ...options, encryptString: () => { throw new Error('keychain unavailable'); } });
  assert.throws(() => failing.addCards([{ number: '123456', password: 'secret' }]), /keychain/);
  assert.equal(failing.getState().cards.length, 0);
  assert.equal(readFileSync(store.filePath, 'utf8'), before);
});

test('verified identical offers merge across cards while conflicting specifications remain separate', () => {
  const { store } = fixture();
  const [first, second] = cards(store);
  store.applySnapshot(first.id, { card: { status: 'active', balance: 100, balanceUnit: '元' }, products: [product(first.id, 'a')] });
  store.favoriteProduct(store.getState().products[0].id);
  store.applySnapshot(second.id, { card: { status: 'active', balance: 100, balanceUnit: '元' }, products: [product(second.id, 'b'), product(second.id, 'c', { specification: '500 g × 3' })] });
  const state = store.getState();
  assert.equal(state.products.length, 2);
  const combined = state.products.find(item => item.specification === '500 g × 2')!;
  assert.equal(combined.offers.length, 2);
  assert.equal(combined.favorite, true);
  assert.equal(state.cards[0].productCount, 1);
  assert.equal(state.cards[1].productCount, 2);
  store.applySnapshot(first.id, { products: [product(first.id, 'a', {}, 12)] });
  const updated = store.getState().products.find(item => item.id === combined.id)!;
  assert.equal(updated.offers.find(offer => offer.cardId === first.id)!.price, 12);
  assert.equal(updated.offers.find(offer => offer.cardId === second.id)!.price, 10);
  assert.equal(updated.favorite, true);
});

test('merged products union official categories from every card offer without replacing source categories', () => {
  const { store, options } = fixture();
  const [first, second] = cards(store);
  const firstSource = product(first.id, 'a', { category: '过时聚合分类', categories: ['过时聚合分类'] });
  firstSource.offers[0].categories = ['美食健康', '节日食品', '美食健康'];
  const secondSource = product(second.id, 'b', { category: '其他聚合分类' });
  secondSource.offers[0].categories = ['节日食品', '居家生活'];
  store.applySnapshot(first.id, { products: [firstSource] });
  store.applySnapshot(second.id, { products: [secondSource] });

  const state = store.getState();
  assert.equal(state.products.length, 1);
  const merged = state.products[0];
  assert.deepEqual(merged.categories, ['美食健康', '节日食品', '居家生活']);
  assert.equal(merged.category, '美食健康');
  assert.deepEqual(merged.offers.find(offer => offer.cardId === first.id)!.categories, ['美食健康', '节日食品']);
  assert.deepEqual(merged.offers.find(offer => offer.cardId === second.id)!.categories, ['节日食品', '居家生活']);
  assert.deepEqual(firstSource.offers[0].categories, ['美食健康', '节日食品', '美食健康']);
  assert.deepEqual(new HubStore(options).getState().products[0].categories, merged.categories);
});

test('a surviving offer retains known categories when a later snapshot omits its category mapping', () => {
  const { store } = fixture();
  const [first, second] = cards(store);
  const firstSource = product(first.id, 'a');
  firstSource.offers[0].categories = ['美食健康', '节日食品'];
  const secondSource = product(second.id, 'b');
  secondSource.offers[0].categories = ['个护美妆'];
  store.applySnapshot(first.id, { products: [firstSource] });
  store.applySnapshot(second.id, { products: [secondSource] });
  const mergedId = store.getState().products[0].id;

  const withoutMapping = product(first.id, 'a', { category: '未分类' }, 12);
  assert.equal(withoutMapping.offers[0].categories, undefined);
  store.applySnapshot(first.id, { products: [withoutMapping] });
  const updated = store.getState().products[0];
  assert.equal(updated.id, mergedId);
  assert.equal(updated.offers.find(offer => offer.cardId === first.id)!.price, 12);
  assert.deepEqual(updated.offers.find(offer => offer.cardId === first.id)!.categories, ['美食健康', '节日食品']);
  assert.deepEqual(updated.offers.find(offer => offer.cardId === second.id)!.categories, ['个护美妆']);
  assert.deepEqual(new Set(updated.categories), new Set(['美食健康', '节日食品', '个护美妆']));
  assert.ok(!updated.categories?.includes('未分类'));
});

test('removing one source removes only its categories while surviving sources keep shared categories', () => {
  const { store } = fixture();
  const [first, second] = cards(store);
  const removedSource = product(first.id, 'a');
  removedSource.offers[0].categories = ['美食健康', '节日食品'];
  const survivingSource = product(first.id, 'a2');
  survivingSource.offers[0].categories = ['居家生活'];
  const otherCardSource = product(second.id, 'b');
  otherCardSource.offers[0].categories = ['节日食品'];
  store.applySnapshot(first.id, { products: [removedSource, survivingSource] });
  store.applySnapshot(second.id, { products: [otherCardSource] });
  const mergedId = store.getState().products[0].id;

  store.applySnapshot(first.id, { products: [survivingSource] });
  const state = store.getState();
  const updated = state.products[0];
  assert.equal(state.products.length, 1);
  assert.equal(updated.id, mergedId);
  assert.deepEqual(new Set(updated.offers.map(offer => offer.sourceId)), new Set(['a2', 'b']));
  assert.deepEqual(new Set(updated.categories), new Set(['居家生活', '节日食品']));
  assert.equal(updated.category, updated.categories![0]);
  assert.equal(state.cards.find(card => card.id === first.id)!.productCount, 1);
  assert.equal(state.cards.find(card => card.id === second.id)!.productCount, 1);

  store.applySnapshot(first.id, { products: [] });
  assert.deepEqual(store.getState().products[0].categories, ['节日食品']);
  store.applySnapshot(second.id, { products: [] });
  assert.equal(store.getState().products.length, 0);
});

test('error-only login snapshots preserve the last successful sync time and cached data until recovery', () => {
  const { store, options } = fixture();
  const [first, second] = cards(store);
  const order = { id: 'cached-order', cardId: first.id, sourceId: 'order-a', name: '已兑换订单', status: '已发货', amount: 10, createdAt: '2026-10-02T03:00:00Z', tracking: '', url: '' };
  store.applySnapshot(first.id, { card: { status: 'active', balance: 100, balanceUnit: '元' }, products: [product(first.id, 'a')], orders: [order] });
  const successful = store.getState();
  const syncedAt = successful.cards.find(card => card.id === first.id)!.syncedAt;
  assert.equal(syncedAt, '2026-10-02T04:00:00.000Z');

  options.now = () => new Date('2026-10-02T05:00:00Z');
  store.applySnapshot(first.id, { card: { status: 'pending', error: '官网会话失效，请重新登录' } });
  store.applySnapshot(second.id, { card: { status: 'error', error: '首次登录未完成' } });
  const failed = store.getState();
  const failedCard = failed.cards.find(card => card.id === first.id)!;
  assert.equal(failedCard.status, 'pending');
  assert.equal(failedCard.error, '官网会话失效，请重新登录');
  assert.equal(failedCard.syncedAt, syncedAt);
  assert.equal(failedCard.balance, 100);
  assert.equal(failed.cards.find(card => card.id === second.id)!.syncedAt, null);
  assert.deepEqual(failed.products, successful.products);
  assert.deepEqual(failed.orders, successful.orders);

  const reopened = new HubStore(options);
  assert.equal(reopened.getState().cards.find(card => card.id === first.id)!.syncedAt, syncedAt);
  options.now = () => new Date('2026-10-02T06:00:00Z');
  reopened.applySnapshot(first.id, { card: { status: 'active', balance: 90, error: null } });
  const recovered = reopened.getState().cards.find(card => card.id === first.id)!;
  assert.equal(recovered.syncedAt, '2026-10-02T06:00:00.000Z');
  assert.equal(recovered.balance, 90);
  assert.equal(recovered.error, null);
});

test('empty merge keys do not merge; explicit manual merge survives disappearance and later snapshots', () => {
  const { store, options } = fixture();
  const [first, second] = cards(store);
  store.applySnapshot(first.id, { products: [product(first.id, 'a', { mergeKey: '' })] });
  store.applySnapshot(second.id, { products: [product(second.id, 'b', { mergeKey: '', name: '同物不同名称' })] });
  assert.equal(store.getState().products.length, 2);
  const ids = store.getState().products.map(product => product.id);
  store.mergeProducts(ids);
  store.favoriteProduct(ids[0]);
  store.applySnapshot(first.id, { products: [] });
  store.applySnapshot(second.id, { products: [] });
  assert.equal(store.getState().products.length, 1);
  const reopened = new HubStore(options);
  reopened.applySnapshot(first.id, { products: [product(first.id, 'a', { mergeKey: '', name: '新标题' })] });
  reopened.applySnapshot(second.id, { products: [product(second.id, 'b', { mergeKey: '', name: '别名' })] });
  const merged = reopened.getState().products[0];
  assert.equal(merged.id, ids[0]);
  assert.equal(merged.favorite, true);
  assert.equal(merged.offers.length, 2);
});

test('unknown balance remains unknown; known zero alone marks exhaustion and optional archival', () => {
  const { store } = fixture();
  const [first, second] = cards(store);
  store.applySnapshot(first.id, { card: { status: 'active', balance: null, balanceUnit: '元' } });
  assert.equal(store.getState().cards[0].balance, null);
  assert.equal(store.getState().cards[0].archived, false);
  assert.equal(store.getState().cards[0].status, 'active');
  store.applySnapshot(second.id, { card: { status: 'active', balance: 0, balanceUnit: '次' } });
  assert.equal(store.getState().cards[1].status, 'exhausted');
  assert.equal(store.getState().cards[1].archived, true);
  store.updateSettings({ autoArchive: false });
  store.applySnapshot(first.id, { card: { balance: 0 } });
  assert.equal(store.getState().cards[0].status, 'exhausted');
  assert.equal(store.getState().cards[0].archived, false);
});

test('cart rejects invalid quantity, unsupported cards, vanished offer, stock and total overspend', () => {
  const { store } = fixture();
  const [first, second] = cards(store);
  store.applySnapshot(first.id, { card: { status: 'active', balance: 25, balanceUnit: '元' }, products: [product(first.id, 'a')] });
  const id = store.getState().products[0].id;
  assert.throws(() => store.addToCart(id, first.id, 1.5), /整数/);
  assert.throws(() => store.addToCart(id, first.id, 100), /99/);
  assert.throws(() => store.addToCart(id, second.id, 1), /登录/);
  store.addToCart(id, first.id, 2);
  assert.equal(store.quoteCart(first.id).total, 20);
  assert.throws(() => store.addToCart(id, first.id, 1), /不足/);
  const item = store.getState().cart[0];
  assert.throws(() => store.updateCart(item.id, 21), /库存/);
  assert.equal(store.getState().cart[0].quantity, 2);
  store.updateCard(first.id, { archived: true });
  assert.throws(() => store.quoteCart(first.id), /归档/);
  store.updateCard(first.id, { archived: false });
  store.applySnapshot(first.id, { products: [] });
  assert.throws(() => store.quoteCart(first.id), /报价已失效/);
  store.updateCart(item.id, 0);
  assert.equal(store.getState().cart.length, 0);
  store.applySnapshot(first.id, { card: { expiresAt: '2026-10-01' }, products: [product(first.id, 'a')] });
  assert.throws(() => store.addToCart(store.getState().products[0].id, first.id, 1), /过期/);
});

test('redemption counts are never compared to monetary prices; same count units enforce count capacity', () => {
  const { store } = fixture();
  const [first] = cards(store);
  store.applySnapshot(first.id, { card: { status: 'active', balance: 1, balanceUnit: '次' }, products: [product(first.id, 'a', {}, 500)] });
  const id = store.getState().products[0].id;
  store.addToCart(id, first.id, 1);
  assert.equal(store.quoteCart(first.id).total, 500);
  assert.ok(store.quoteCart(first.id).warnings.some(message => message.includes('兑换次数')));
  store.updateCart(store.getState().cart[0].id, 0);
  const countProduct = product(first.id, 'a');
  countProduct.offers[0].price = 1;
  countProduct.offers[0].priceUnit = '次';
  store.applySnapshot(first.id, { products: [countProduct] });
  store.addToCart(id, first.id, 1);
  assert.throws(() => store.addToCart(id, first.id, 1), /兑换次数不足/);
});

test('unknown quotes cannot bypass the known subtotal limit when adding, updating or quoting a cart', () => {
  const { store } = fixture();
  const [first] = cards(store);
  const known = product(first.id, 'known', { mergeKey: '' }, 10);
  const unknown = product(first.id, 'unknown', { mergeKey: '' });
  unknown.offers[0].price = null;
  store.applySnapshot(first.id, { card: { status: 'active', balance: 25, balanceUnit: '元' }, products: [known, unknown] });
  store.addToCart(unknown.id, first.id, 1);
  store.addToCart(known.id, first.id, 2);
  assert.equal(store.quoteCart(first.id).total, null);
  const before = store.getState();
  assert.throws(() => store.addToCart(known.id, first.id, 1), /余额或兑换次数不足/);
  assert.throws(() => store.updateCart(before.cart.find(item => item.productId === known.id)!.id, 3), /余额或兑换次数不足/);
  assert.deepEqual(store.getState(), before);
  known.offers[0].price = 15;
  store.applySnapshot(first.id, { products: [known, unknown] });
  assert.throws(() => store.quoteCart(first.id), /余额或兑换次数不足/);
});

test('mixed units and missing quote units cannot hide an exceeded known redemption subtotal', () => {
  const { store } = fixture();
  const [first] = cards(store);
  const counted = product(first.id, 'counted', { mergeKey: '' }, 1);
  counted.offers[0].priceUnit = '兑换次数';
  const money = product(first.id, 'money', { mergeKey: '' }, 500);
  const noUnit = product(first.id, 'no-unit', { mergeKey: '' }, 500);
  noUnit.offers[0].priceUnit = '';
  store.applySnapshot(first.id, { card: { status: 'active', balance: 2, balanceUnit: '次' }, products: [counted, money, noUnit] });
  store.addToCart(money.id, first.id, 1);
  store.addToCart(noUnit.id, first.id, 1);
  store.addToCart(counted.id, first.id, 2);
  assert.equal(store.quoteCart(first.id).total, null);
  assert.throws(() => store.addToCart(counted.id, first.id, 1), /兑换次数不足/);
  const before = store.getState();
  store.applySnapshot(first.id, { card: { balance: null } });
  store.updateCart(before.cart.find(item => item.productId === counted.id)!.id, 3);
  assert.equal(store.quoteCart(first.id).total, null);
});

test('unknown price and stock warn without inventing a total; expiry includes China calendar end of day', () => {
  const { store } = fixture();
  const [first] = cards(store);
  const unknown = product(first.id, 'a');
  unknown.offers[0].price = null;
  unknown.offers[0].stock = null;
  store.applySnapshot(first.id, { card: { status: 'active', balance: null, expiresAt: '2026-10-02' }, products: [unknown] });
  store.addToCart(unknown.id, first.id, 99);
  assert.equal(store.quoteCart(first.id).total, null);
  assert.equal(store.quoteCart(first.id).warnings.length, 3);
});

test('single-selection ceilings do not become a shared monetary purse, and source extras stay outside the public state', () => {
  const { store } = fixture();
  const [first] = cards(store);
  const source = product(first.id, 'a', { mergeKey: '' }, 100);
  source.offers[0].priceUnit = '单次任选额度';
  source.offers.push({ ...source.offers[0], sourceId: 'b' });
  Object.assign(source, { password: 'unexpected-source-secret' });
  Object.assign(source.offers[0], { token: 'unexpected-source-secret' });
  store.applySnapshot(first.id, { card: { status: 'active', balance: 100, balanceUnit: '单次任选额度' }, products: [source] });
  assert.equal(store.getState().products.length, 1);
  assert.equal(store.getState().products[0].offers.length, 2);
  assert.ok(!JSON.stringify(store.getState()).includes('unexpected-source-secret'));
  store.addToCart(source.id, first.id, 2, 'a');
  assert.equal(store.quoteCart(first.id).total, 200);
  assert.ok(store.quoteCart(first.id).warnings.some(message => message.includes('单次兑换上限')));
});

test('manual multi-offer products require an exact source selection, and reject a foreign source atomically', () => {
  const { store } = fixture();
  const [first] = cards(store);
  const cheap = product(first.id, 'cheap', { mergeKey: '' }, 5);
  const selected = product(first.id, 'chosen', { mergeKey: '', name: '另一规格' }, 15);
  selected.offers[0].variant = '其他规格';
  store.applySnapshot(first.id, { card: { status: 'active', balance: 100, balanceUnit: '元' }, products: [cheap, selected] });
  store.mergeProducts([cheap.id, selected.id]);
  assert.throws(() => store.addToCart(cheap.id, first.id, 1), /选择具体报价/);
  assert.throws(() => store.addToCart(cheap.id, first.id, 1, 'not-this-card'), /没有该商品的报价/);
  assert.equal(store.getState().cart.length, 0);
  store.addToCart(cheap.id, first.id, 2, 'chosen');
  assert.equal(store.getState().cart[0].sourceId, 'chosen');
  assert.equal(store.quoteCart(first.id).total, 30);
  store.addToCart(cheap.id, first.id, 1, 'cheap');
  assert.equal(store.getState().cart.length, 2);
  assert.equal(store.quoteCart(first.id).total, 35);
});

test('snapshot validation is atomic, cannot overwrite other card orders, and rejects forged cross-card offers', () => {
  const { store } = fixture();
  const [first, second] = cards(store);
  const order = { id: 'same-source-id', cardId: first.id, sourceId: 'order-a', name: '订单 A', status: '已发货', amount: null, createdAt: '', tracking: '', url: '' };
  store.applySnapshot(first.id, { orders: [order] });
  store.applySnapshot(second.id, { orders: [{ ...order, cardId: second.id, sourceId: 'order-b' }] });
  assert.equal(store.getState().orders.length, 2);
  assert.equal(new Set(store.getState().orders.map(order => order.id)).size, 2);
  const before = store.getState();
  assert.throws(() => store.applySnapshot(first.id, { card: { balance: 10 }, products: [product(second.id, 'bad')] }), /其他卡片/);
  assert.deepEqual(store.getState(), before);
});

test('portable backup hides secrets, rejects wrong passwords and corruption, and restores onto another encryption key', () => {
  const { store } = fixture();
  const [first] = cards(store);
  store.applySnapshot(first.id, { card: { status: 'active', balance: 100, balanceUnit: '元' }, products: [product(first.id, 'a')] });
  store.favoriteProduct(store.getState().products[0].id);
  const backup = store.exportBackup('correct-passphrase');
  assert.ok(!backup.includes('fixture-password-one'));
  assert.ok(!backup.includes(first.number));
  const target = fixture();
  const before = target.store.getState();
  assert.throws(() => target.store.importBackup(backup, 'wrong-passphrase'), /口令错误/);
  assert.deepEqual(target.store.getState(), before);
  const corrupted = JSON.parse(backup);
  corrupted.data = `${corrupted.data[0] === 'A' ? 'B' : 'A'}${corrupted.data.slice(1)}`;
  assert.throws(() => target.store.importBackup(JSON.stringify(corrupted), 'correct-passphrase'), /已损坏/);
  target.store.importBackup(backup, 'correct-passphrase');
  assert.equal(target.store.getPassword(first.id), 'fixture-password-one');
  assert.equal(target.store.getState().products[0].favorite, true);
  assert.equal(target.store.getState().cards[0].balance, 100);
  assert.equal(new HubStore(target.options).getPassword(first.id), 'fixture-password-one');
  assert.ok(!readFileSync(target.store.filePath, 'utf8').includes('fixture-password-one'));
});
