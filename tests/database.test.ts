import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { HubStore } from '../electron/store';
import { AddressVault, type AddressDraft } from '../electron/addresses';
import { SessionVault } from '../electron/session-vault';
import { openStorage } from '../electron/storage-migration';
import { SqliteRepository } from '../electron/sqlite-repository';
import { BackupService } from '../electron/backup-service';
import { diagnosticSummary } from '../electron/redaction';
import { DATABASE_VERSION } from '../electron/database-migrations';
import { DEFAULT_PRODUCT_QUERY,DEFAULT_ORDER_QUERY,type SyncTask } from '../src/shared/operations';
import { queryProductsInMemory,queryOrdersInMemory } from '../src/shared/queries';
import type { Product } from '../src/shared/types';
import type { TradeAttempt } from '../src/shared/trade';

const directories: string[] = [];
const databases: SqliteRepository[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function options() {
  const directory = mkdtempSync(join(tmpdir(), 'gat-sqlite-'));
  directories.push(directory);
  const key = randomBytes(32);
  return {
    directory, now: () => new Date('2026-10-08T04:00:00.000Z'),
    encryptString(value: string) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}
function open(config = options()) {
  const db = openStorage(config); databases.push(db);
  const store = new HubStore({ ...config, repository: db });
  const addresses = new AddressVault({ ...config, repository: db });
  const sessions = new SessionVault({ ...config, now: () => config.now().getTime() / 1000, repository: db });
  return { config, db, store, addresses, sessions, backups: new BackupService(db, store, addresses) };
}
const draft: AddressDraft = {
  label: '家', recipient: '数据库测试收件人', phone: '13800138000', province: '上海市', city: '上海市', district: '黄浦区',
  town: '', detail: '敏感测试地址 100 号', postalCode: '', provinceId: '', cityId: '', districtId: '', townId: '',
};
function product(cardId: string, sourceId: string, price: number | null = null): Product {
  return { id: `product-${sourceId}`, name: `商品${sourceId}`, brand: '', specification: '500g', category: '食品', categories: ['食品'], image: '', mergeKey: '', favorite: false,
    offers: [{ cardId, sourceId, price, priceUnit: '元', stock: null, url: 'https://a.guanaitong.com/product', variant: '', syncedAt: '2026-10-08T04:00:00.000Z', categories: ['食品'] }] };
}
function seed(store: HubStore) {
  const [card] = store.addCards([{ number: '123456789012', password: 'database-fixture-password', label: '测试卡' }]).cards;
  store.applySnapshot(card.id, {
    card: { status: 'active', balance: null }, products: [product(card.id, 'a'), product(card.id, 'b', 12)],
    orders: [{ id: 'order-a', cardId: card.id, sourceId: 'official-order-a', name: '订单', amount: null, status: '已完成', createdAt: '2026-10-01', tracking: '', url: '' }],
  });
  store.favoriteProduct('product-a');
  store.mergeProducts(['product-a', 'product-b']);
  store.addToCart('product-a', card.id, 1, 'a');
  return card.id;
}
const cookies = (value = 'database-fixture-cookie') => [{ name: 'fixture', value, domain: '.guanaitong.com', path: '/', secure: true, httpOnly: true }];
function inspect(path: string, fn: (db: DatabaseSync) => void) {
  const raw = new DatabaseSync(path);
  try { fn(raw); } finally { raw.close(); }
}
function assertNoSecrets(bytes: Buffer) {
  for (const secret of ['123456789012', 'database-fixture-password', 'database-fixture-cookie', draft.recipient, draft.phone, draft.detail]) assert.equal(bytes.includes(Buffer.from(secret)), false, `Unexpected plaintext: ${secret}`);
}

test('SQLite persists normalized relations, NULL values and encrypted fields across reopening', async () => {
  const f = open(); const id = seed(f.store); f.addresses.save(draft);
  await f.sessions.save(id, async () => cookies());
  const expected = f.store.getState(), book = f.addresses.list();
  inspect(f.db.filePath, raw => {
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, DATABASE_VERSION);
    assert.equal(raw.prepare('SELECT balance FROM cards').get()!.balance, null);
    assert.equal(raw.prepare("SELECT price,stock FROM offers WHERE source_id='a'").get()!.price, null);
    assert.equal(raw.prepare('SELECT stock FROM offers').get()!.stock, null);
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM offers').get()!.n, 2);
  });
  const copy = f.db.backup('test-snapshot'); assertNoSecrets(readFileSync(copy));
  f.db.close(); assertNoSecrets(readFileSync(f.db.filePath));
  const next = open(f.config);
  assert.deepEqual(next.store.getState(), expected); assert.deepEqual(next.addresses.list(), book);
  assert.equal(next.sessions.load(id)[0].value, 'database-fixture-cookie');
  next.store.applySnapshot(id, { products: [] });
  assert.equal(next.store.getState().cart.length, 1, 'stale cart quote survives');
  assert.throws(() => next.store.quoteCart(id), /报价已失效/);
  next.store.applySnapshot(id, { products: [product(id, 'b', 12)] });
  assert.equal(next.store.getState().products.find(item => item.offers.length)!.id, 'product-a', 'manual merge survives disappearing offers');
});

test('legacy cards, favorites, merges, cart, orders, addresses and cookies migrate once with byte-identical backups', async () => {
  const config = options(); const legacy = new HubStore(config), id = seed(legacy);
  const address = new AddressVault(config); address.save(draft);
  const sessions = new SessionVault({ ...config, now: () => config.now().getTime() / 1000 }); await sessions.save(id, async () => cookies());
  const names = readdirSync(config.directory), originals = new Map(names.map(name => [name, readFileSync(join(config.directory, name))]));
  const f = open(config);
  assert.deepEqual(f.store.getState(), legacy.getState()); assert.deepEqual(f.addresses.list(), address.list());
  assert.equal(f.sessions.load(id)[0].value, 'database-fixture-cookie');
  const backupName = readdirSync(join(config.directory, 'backups')).find(name => name.startsWith('legacy-'))!;
  for (const [name, bytes] of originals) {
    assert.deepEqual(readFileSync(join(config.directory, name)), bytes);
    assert.deepEqual(readFileSync(join(config.directory, 'backups', backupName, name)), bytes);
  }
  f.store.updateSettings({ maskNumbers: false }); f.db.close();
  writeFileSync(legacy.filePath, 'intentionally damaged old file');
  assert.equal(open(config).store.getState().settings.maskNumbers, false, 'completed migration never reimports stale files');
});

test('malformed legacy address aborts all domains and can be retried after repair', () => {
  const config = options(), legacy = new HubStore(config); seed(legacy);
  const address = new AddressVault(config); address.save(draft);
  const goodAddress = readFileSync(address.filePath), oldCards = readFileSync(legacy.filePath);
  writeFileSync(address.filePath, 'damaged');
  assert.throws(() => openStorage(config), /解密|格式/);
  const uninitialized = new SqliteRepository(config); databases.push(uninitialized);
  assert.equal(uninitialized.initialized(), false); assert.equal(uninitialized.loadHub(), null); uninitialized.close();
  assert.deepEqual(readFileSync(legacy.filePath), oldCards); assert.equal(readFileSync(address.filePath, 'utf8'), 'damaged');
  writeFileSync(address.filePath, goodAddress);
  assert.equal(open(config).store.getState().cards.length, 1);
});

test('wrong OS key aborts migration without rewriting encrypted credentials or addresses', () => {
  const config = options(), legacy = new HubStore(config); seed(legacy);
  const before = readFileSync(legacy.filePath);
  assert.throws(() => openStorage({ ...config, decryptString: () => { throw new Error('wrong OS key'); } }), /无法解密/);
  assert.deepEqual(readFileSync(legacy.filePath), before);
  assert.equal(open(config).store.getState().cards.length, 1);
});

test('mid-transaction SQL failure rolls back balance, products, orders, cart and activity together', () => {
  const f = open(), id = seed(f.store), before = f.store.getState();
  inspect(f.db.filePath, raw => raw.exec("CREATE TRIGGER fail_orders BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT,'fixture-write-failed'); END;"));
  assert.throws(() => f.store.applySnapshot(id, { card: { balance: 500 }, products: [product(id, 'new', 10)], orders: before.orders.map(order=>({...order,amount:5})), activity: { message: 'must roll back', type: 'success' } }), /fixture-write-failed/);
  assert.deepEqual(f.store.getState(), before);
  assert.deepEqual(new HubStore({ ...f.config, repository: f.db }).getState(), before);
  inspect(f.db.filePath, raw => raw.exec('DROP TRIGGER fail_orders'));
  f.store.applySnapshot(id, { card: { balance: 500 }, activity: { message: 'complete', type: 'success' } });
  assert.equal(f.store.getState().cards[0].balance, 500);
});

test('foreign keys and uniqueness reject orphan quotes, duplicate source assignment and two default addresses', () => {
  const f = open(); seed(f.store); f.addresses.save(draft);
  inspect(f.db.filePath, raw => {
    raw.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => raw.prepare('INSERT INTO offers VALUES (?, ?, ?, ?, ?, ?, ?)').run('missing-card', 'new', 'product-a', 99, null, null, Buffer.from('bad')), /FOREIGN KEY/);
    assert.throws(() => raw.exec('INSERT INTO offers SELECT * FROM offers LIMIT 1'), /UNIQUE/);
    assert.throws(() => raw.prepare('INSERT INTO addresses VALUES (?, ?, ?, ?)').run('new-address', 99, 1, Buffer.from('bad')), /UNIQUE/);
  });
});

test('write queue and same-card cookie capture recover after failed jobs and preserve logout', async () => {
  const f = open(), id = seed(f.store);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const first = f.sessions.save(id, async () => { calls.push('first'); await gate; return cookies('old'); });
  const second = f.sessions.save(id, async () => { calls.push('second'); return cookies('new'); });
  await f.db.enqueueWrite(() => f.store.updateSettings({ maskNumbers: false }));
  assert.deepEqual(calls, ['first']); release(); await Promise.all([first, second]);
  assert.equal(f.sessions.load(id)[0].value, 'new');
  await assert.rejects(f.db.enqueueWrite(() => { throw new Error('failed write'); }), /failed write/);
  await assert.rejects(f.sessions.save('orphan', async () => cookies()), /FOREIGN KEY/);
  await f.db.enqueueWrite(() => f.store.updateSettings({ maskNumbers: true }));
  await f.sessions.save(id, async () => []); await f.sessions.flush(); await f.db.flush();
  assert.deepEqual(f.sessions.load(id), []);
});

test('unified password backup previews without writes, migrates between OS keys and clears old cookies', async () => {
  const source = open(), id = seed(source.store); source.addresses.save(draft);
  await source.sessions.save(id, async () => cookies());
  const backup = source.backups.export('portable-password');
  assert.equal(JSON.parse(backup).version, 4); assertNoSecrets(Buffer.from(backup));
  const destination = open(); const previousId = seed(destination.store);
  await destination.sessions.save(previousId, async () => cookies('obsolete'));
  destination.addresses.save({ ...draft, recipient: '旧收件人' });
  const previous = destination.store.getState(), book = destination.addresses.list();
  assert.throws(() => destination.backups.prepare(backup, 'wrong-password'), /口令错误/);
  const tampered = JSON.parse(backup); tampered.tag = randomBytes(16).toString('base64');
  assert.throws(() => destination.backups.prepare(JSON.stringify(tampered), 'portable-password'), /损坏/);
  const prepared = destination.backups.prepare(backup, 'portable-password');
  assert.equal(prepared.kind, 'unified'); assert.equal(prepared.addresses!.length, 1);
  assert.deepEqual(destination.store.getState(), previous); assert.deepEqual(destination.addresses.list(), book);
  destination.backups.apply(prepared);
  assert.deepEqual(destination.store.getState(), source.store.getState());
  assert.deepEqual(destination.addresses.list(), source.addresses.list());
  assert.deepEqual(destination.sessions.load(previousId), []); assert.deepEqual(destination.sessions.load(id), []);
  destination.db.close();
  const reopened = open(destination.config);
  assert.equal(reopened.store.getPassword(id), 'database-fixture-password'); assert.equal(reopened.addresses.list()[0].recipient, draft.recipient);
  assert.ok(readdirSync(join(destination.config.directory, 'backups')).some(name => name.startsWith('before-restore-')));
});

test('failed unified restore preserves all current domains and creates a complete WAL-aware safety backup', async () => {
  const source = open(); seed(source.store); source.addresses.save(draft);
  const f = open(), id = seed(f.store); f.addresses.save({ ...draft, recipient: '保留收件人' });
  await f.sessions.save(id, async () => cookies());
  const before = f.store.getState(), book = f.addresses.list();
  const prepared = f.backups.prepare(source.backups.export('portable-password'), 'portable-password');
  inspect(f.db.filePath, raw => raw.exec("CREATE TRIGGER fail_addresses BEFORE INSERT ON addresses BEGIN SELECT RAISE(ABORT,'restore-write-failed'); END;"));
  assert.throws(() => f.backups.apply(prepared), /restore-write-failed/);
  assert.deepEqual(f.store.getState(), before); assert.deepEqual(f.addresses.list(), book); assert.equal(f.sessions.load(id)[0].value, 'database-fixture-cookie');
  assert.deepEqual(new HubStore({ ...f.config, repository: f.db }).getState(), before);
  const name = readdirSync(join(f.config.directory, 'backups')).find(name => name.startsWith('before-restore-'))!;
  inspect(join(f.config.directory, 'backups', name), raw => {
    assert.equal(raw.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM addresses').get()!.n, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
  });
  assertNoSecrets(readFileSync(join(f.config.directory, 'backups', name)));
});

test('legacy card and address backups retain domains not included in the selected backup', async () => {
  const sourceConfig = options(), legacy = new HubStore(sourceConfig); seed(legacy);
  const legacyAddresses = new AddressVault(sourceConfig); legacyAddresses.save(draft);
  const f = open(), id = seed(f.store); f.addresses.save({ ...draft, recipient: '保留地址' });
  await f.sessions.save(id, async () => cookies());
  const book = f.addresses.list();
  const cardBackup = f.backups.prepare(legacy.exportBackup('portable-password'), 'portable-password');
  assert.equal(cardBackup.kind, 'cards'); f.backups.apply(cardBackup);
  assert.deepEqual(f.addresses.list(), book); assert.deepEqual(f.sessions.load(id), []);
  const cardId = f.store.getState().cards[0].id; await f.sessions.save(cardId, async () => cookies());
  const state = f.store.getState();
  const addressBackup = f.backups.prepare(legacyAddresses.exportBackup('address-password'), 'address-password');
  assert.equal(addressBackup.kind, 'addresses'); f.backups.apply(addressBackup);
  assert.deepEqual(f.store.getState(), state); assert.deepEqual(f.addresses.list(), legacyAddresses.list());
  assert.equal(f.sessions.load(cardId)[0].value, 'database-fixture-cookie');
});

test('invalid address inside an otherwise valid unified envelope is rejected before any write', () => {
  const f = open(); seed(f.store); f.addresses.save(draft);
  const backup = JSON.parse(f.backups.export('portable-password'));
  const key = scryptSync('portable-password', Buffer.from(backup.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'base64'));
  decipher.setAAD(Buffer.from(`guanaitong-hub-backup:${backup.version}`)); decipher.setAuthTag(Buffer.from(backup.tag, 'base64'));
  const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(backup.data, 'base64')), decipher.final()]).toString());
  data.addresses[0].phone = 'invalid';
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'base64')); cipher.setAAD(Buffer.from(`guanaitong-hub-backup:${backup.version}`));
  backup.data = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64'); backup.tag = cipher.getAuthTag().toString('base64'); key.fill(0);
  const before = f.store.getState(), addresses = f.addresses.list();
  assert.throws(() => f.backups.prepare(JSON.stringify(backup), 'portable-password'), /手机号/);
  assert.deepEqual(f.store.getState(), before); assert.deepEqual(f.addresses.list(), addresses);
});
test('schema v1 upgrades with a restorable safety copy and preserves existing cards', () => {
  const f = open(); seed(f.store); const before = f.store.getState(); f.db.close();
  inspect(f.db.filePath, raw => raw.exec('DROP TABLE trade_attempts; DROP TABLE sessions; DROP TABLE price_history; DROP TABLE sync_tasks; DROP INDEX products_favorite; DROP INDEX cart_card; DELETE FROM schema_migrations WHERE version>1; PRAGMA user_version=1;'));
  const next = open(f.config); assert.deepEqual(next.store.getState(), before);
  const name = readdirSync(join(f.config.directory, 'backups')).find(name => name.startsWith(`before-schema-v1-to-v${DATABASE_VERSION}-`))!;
  inspect(join(f.config.directory, 'backups', name), raw => assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 1));
});

test('failed schema upgrade leaves version and old records unchanged and succeeds on retry', () => {
  const f = open(); seed(f.store); const before = f.store.getState(); f.db.close();
  inspect(f.db.filePath, raw => raw.exec('DROP TABLE trade_attempts; DELETE FROM schema_migrations WHERE version>1; DROP TABLE price_history; DROP TABLE sync_tasks; DROP INDEX products_favorite; DROP INDEX cart_card; PRAGMA user_version=1;'));
  assert.throws(() => openStorage(f.config), /already exists/);
  inspect(f.db.filePath, raw => {
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM cards').get()!.n, 1);
    raw.exec('DROP TABLE sessions');
  });
  assert.deepEqual(open(f.config).store.getState(), before);
});

test('newer schema and physically corrupt database are never overwritten on startup', () => {
  const f = open(); seed(f.store); f.db.close();
  inspect(f.db.filePath, raw => raw.exec('PRAGMA user_version=999'));
  const newer = readFileSync(f.db.filePath);
  assert.throws(() => openStorage(f.config), /较新版本/); assert.deepEqual(readFileSync(f.db.filePath), newer);
  const corrupt = Buffer.from('SQLite format 3\0invalid contents'); writeFileSync(f.db.filePath, corrupt);
  assert.throws(() => openStorage(f.config)); assert.deepEqual(readFileSync(f.db.filePath), corrupt);
});

test('activity and diagnostic exports redact credentials and omit address/cookie content', () => {
  const f = open(), id = seed(f.store); f.addresses.save(draft);
  f.store.addActivity('123456789012 password=database-fixture-password cookie=private-token 手机13800138000', 'warning', id);
  const message = f.store.getState().activities[0].message;
  assert.ok(!message.includes('123456789012')); assert.ok(!message.includes('database-fixture-password')); assert.ok(!message.includes('private-token')); assert.ok(!message.includes('13800138000'));
  assertNoSecrets(Buffer.from(JSON.stringify(diagnosticSummary(f.store.getState()))));
});

test('abrupt process exit rolls back an unfinished WAL transaction and retains its last committed state', () => {
  const f = open(); seed(f.store); f.db.close();
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; UPDATE cards SET balance=77; BEGIN IMMEDIATE; UPDATE cards SET balance=999;');
    process.exit(0);
  `, f.db.filePath]);
  const recovered = open(f.config);
  assert.equal(recovered.store.getState().cards[0].balance, 77);
  assert.equal(recovered.store.getState().cart.length, 1);
  assert.equal(recovered.store.getState().products[0].offers.length, 2);
});

test('a missing initialization marker never causes populated SQLite data to be replaced with stale legacy files', () => {
  const f = open(); seed(f.store); f.db.close();
  inspect(f.db.filePath, raw => raw.exec("DELETE FROM storage_meta WHERE key='initialized'"));
  const before = readFileSync(f.db.filePath);
  assert.throws(() => openStorage(f.config), /初始化记录缺失/);
  assert.deepEqual(readFileSync(f.db.filePath), before);
});

test('system encryption failure preserves SQLite rows and memory before any transaction begins', async () => {
  const f = open(), id = seed(f.store); f.addresses.save(draft); await f.sessions.save(id, async () => cookies());
  const before = f.store.getState(), book = f.addresses.list();
  const brokenOptions = { ...f.config, encryptString: () => { throw new Error('keychain unavailable'); } };
  const brokenDb = new SqliteRepository(brokenOptions); databases.push(brokenDb);
  const brokenStore = new HubStore({ ...brokenOptions, repository: brokenDb });
  const brokenAddresses = new AddressVault({ ...brokenOptions, repository: brokenDb });
  const brokenSessions = new SessionVault({ ...brokenOptions, now: () => Date.now() / 1000, repository: brokenDb });
  assert.throws(() => brokenStore.applySnapshot(id, { card: { balance: 900 } }), /keychain unavailable/);
  assert.throws(() => brokenAddresses.save({ ...draft, recipient: 'cannot persist' }), /keychain unavailable/);
  await assert.rejects(brokenSessions.save(id, async () => cookies('cannot persist')), /keychain unavailable/);
  assert.deepEqual(brokenStore.getState(), before); assert.deepEqual(brokenAddresses.list(), book);
  assert.deepEqual(f.db.loadHub()!.state, before); assert.deepEqual(f.db.loadAddresses(), book); assert.equal(f.sessions.load(id)[0].value, 'database-fixture-cookie');
});

test('SQL catalog filters and sort match existing exact-source semantics, with bounded pages', () => {
  const f=open(),first=seed(f.store);
  const second=f.store.addCards([{number:'987654321012',password:'fixture-two'}]).cards[1];
  const p=product(second.id,'c',15);p.offers[0].categories=['3C数码'];
  f.store.applySnapshot(second.id,{card:{status:'active',balance:100},products:[p,product(second.id,'d',0)]});
  const state=f.store.getState();
  for(const cardId of ['all',first,second.id])for(const category of ['全部分类','食品','数码3C'])for(const sort of ['default','ascending','descending'] as const){
    const query={...structuredClone(DEFAULT_PRODUCT_QUERY),cardId,category,pageSize:2,price:{amounts:[] as number[],unit:sort==='default'?'all':'元',sort}};
    const actual=f.db.queryProducts(query),expected=queryProductsInMemory(state,query);
    assert.deepEqual(actual.items.map(item=>item.id),expected.items.map(item=>item.id));assert.equal(actual.total,expected.total);
  }
  const exact={...structuredClone(DEFAULT_PRODUCT_QUERY),cardId:first,category:'食品',price:{unit:'元',amounts:[12],sort:'default' as const}};
  assert.equal(f.db.queryProducts(exact).total,1);
  assert.equal(f.db.queryProducts({...exact,category:'数码3C'}).total,0,'price and category must match the same source');
  assert.equal(f.db.queryProducts({...exact,search:'不存在'}).total,0);
  assert.throws(()=>f.db.queryProducts({...exact,pageSize:1000}),/分页/);
});

test('delisted favorites stay searchable and manageable without matching invented source quotes', () => {
  const f = open();
  const card = f.store.addCards([{ number: '123456789012', password: 'database-fixture-password' }]).cards[0];
  const delisted = product(card.id, 'delisted', 12);
  const live = product(card.id, 'live', 10);
  f.store.applySnapshot(card.id, { card: { status: 'active', balance: 100 }, products: [delisted, live] });
  f.store.favoriteProduct(delisted.id);
  f.store.applySnapshot(card.id, { products: [live] });
  assert.deepEqual(f.store.getProduct(delisted.id).offers, []);
  const favorites = { ...structuredClone(DEFAULT_PRODUCT_QUERY), favoritesOnly: true };
  assert.deepEqual(f.db.queryProducts(favorites).items.map(item => item.id), [delisted.id]);
  for (const query of [DEFAULT_PRODUCT_QUERY, favorites, { ...favorites, search: 'delisted' }, { ...favorites, category: '食品' }, { ...favorites, category: '数码3C' }, { ...favorites, cardId: card.id }, { ...favorites, price: { unit: '元', amounts: [], sort: 'default' as const } }, { ...favorites, price: { unit: '元', amounts: [12], sort: 'default' as const } }]) {
    const actual = f.db.queryProducts(query);
    const expected = queryProductsInMemory(f.store.getState(), query);
    assert.deepEqual(actual, { ...expected, categories: expected.categories.filter(category => category.name === '全部分类' || category.count > 0) });
  }
  assert.deepEqual(f.db.queryProducts(favorites).items.map(item => item.id), [delisted.id]);
  assert.equal(f.db.queryProducts({ ...favorites, search: 'delisted' }).total, 1);
  assert.equal(f.db.queryProducts({ ...favorites, category: '食品' }).total, 1);
  assert.equal(f.db.queryProducts({ ...favorites, cardId: card.id }).total, 0);
  assert.equal(f.db.queryProducts({ ...favorites, price: { unit: '元', amounts: [12], sort: 'default' } }).total, 0);
  f.db.close();
  const next = open(f.config);
  assert.deepEqual(next.db.queryProducts(favorites).items.map(item => item.id), [delisted.id]);
  next.store.favoriteProduct(delisted.id);
  assert.equal(next.db.queryProducts(favorites).total, 0);
});

test('large catalogs use small renderer snapshots and update metadata without rewriting product/offer rows', () => {
  let encryptions=0;const config=options(),original=config.encryptString;
  config.encryptString=value=>{encryptions++;return original(value);};
  const f=open(config),card=f.store.addCards([{number:'123456789012',password:'database-fixture-password'}]).cards[0];
  f.store.applySnapshot(card.id,{card:{status:'active',balance:2000},products:Array.from({length:600},(_,i)=>product(card.id,`large-${i}`,i))});
  const full=f.store.getState(),view=f.store.getViewState();
  assert.equal(view.products.length,4);assert.equal(view.summary!.products,600);
  assert.ok(JSON.stringify(view).length<JSON.stringify(full).length/20);
  const page=f.db.queryProducts({...structuredClone(DEFAULT_PRODUCT_QUERY),page:2,pageSize:24});assert.equal(page.items.length,24);assert.equal(page.total,600);
  const before=encryptions;
  inspect(f.db.filePath,raw=>raw.exec("CREATE TRIGGER forbid_product_rewrite BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT,'unexpected-product-rewrite'); END; CREATE TRIGGER forbid_offer_rewrite BEFORE INSERT ON offers BEGIN SELECT RAISE(ABORT,'unexpected-offer-rewrite'); END;"));
  f.store.updateCard(card.id,{label:'metadata only',tags:['福利','福利','到期']});f.store.updateSettings({maskNumbers:false});
  assert.ok(encryptions-before<=3,`expected only changed fields to encrypt, got ${encryptions-before}`);
  assert.deepEqual(f.store.getState().cards[0].tags,['福利','到期']);assert.equal(f.db.queryProducts({...structuredClone(DEFAULT_PRODUCT_QUERY),search:'large-599'}).total,1);
  assert.ok(!readFileSync(f.db.backup('no-private-text')).includes(Buffer.from('商品large-599')),'TEMP search text never reaches the disk backup');
});

test('order filters use China calendar day boundaries, search and status with stable pages', () => {
  const f=open(),id=seed(f.store);
  const base=f.store.getState().orders[0];
  f.store.applySnapshot(id,{orders:[{...base,id:'before-day',sourceId:'before',createdAt:'2026-10-07T15:59:59.999Z'},{...base,id:'start-day',sourceId:'start',createdAt:'2026-10-07T16:00:00.000Z',name:'礼品'},{...base,id:'end-day',sourceId:'end',createdAt:'2026-10-08T15:59:59.999Z',name:'礼品'},{...base,id:'after-day',sourceId:'after',createdAt:'2026-10-08T16:00:00.000Z'}]});
  const query={...DEFAULT_ORDER_QUERY,from:'2026-10-08',to:'2026-10-08',pageSize:1};
  const first=f.db.queryOrders(query);assert.equal(first.total,2);assert.equal(first.items[0].id,'end-day');
  assert.equal(f.db.queryOrders({...query,page:2}).items[0].id,'start-day');
  assert.deepEqual(first.items,queryOrdersInMemory(f.store.getState(),query).items);
  assert.equal(f.db.queryOrders({...query,status:'不存在'}).total,0);
  assert.throws(()=>f.db.queryOrders({...query,from:'2026-02-31'}),/日期/);
});

test('quote history records NULL transitions once, survives backup and rolls back with failed snapshots', () => {
  const source=open(),id=seed(source.store);
  const initial=source.db.priceHistory(id,'a');assert.equal(initial.length,1);assert.equal(initial[0].price,null);
  source.store.applySnapshot(id,{products:[product(id,'a',30),product(id,'b',12)]});
  source.store.applySnapshot(id,{products:[product(id,'a',30),product(id,'b',12)]});assert.equal(source.db.priceHistory(id,'a').length,2);
  const before=source.db.priceHistory(id,'a'),orders=source.store.getState().orders;
  inspect(source.db.filePath,raw=>raw.exec("CREATE TRIGGER fail_history_snapshot BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT,'snapshot-failed'); END;"));
  assert.throws(()=>source.store.applySnapshot(id,{products:[product(id,'a',99)],orders:orders.map(order=>({...order,amount:1}))}),/snapshot-failed/);
  assert.deepEqual(source.db.priceHistory(id,'a'),before);
  const target=open(),prepared=target.backups.prepare(source.backups.export('portable-password'),'portable-password');target.backups.apply(prepared);
  assert.deepEqual(target.db.priceHistory(id,'a'),before);
});

test('persisted active sync batches recover as interrupted and survive unified backup', () => {
  const f=open(),id=seed(f.store);
  const task:SyncTask={id:'task-fixture',batchId:'batch-fixture',cardId:id,status:'running',phase:'products',page:2,completed:100,total:200,message:'读取中',errorKind:null,startedAt:'2026-10-08T00:00:00.000Z',finishedAt:null};
  f.db.saveSyncTask(task);f.db.close();const next=open(f.config);
  const recovered=next.db.recoverInterruptedTasks();assert.equal(recovered[0].status,'interrupted');assert.equal(recovered[0].page,2);
  const destination=open();destination.backups.apply(destination.backups.prepare(next.backups.export('portable-password'),'portable-password'));
  assert.equal(destination.db.syncTasks()[0].status,'interrupted');assert.equal(destination.db.syncTasks()[0].batchId,'batch-fixture');
});

test('schema v2 upgrades to management tables with a safety copy and retains query behavior', () => {
  const f=open();seed(f.store);const before=f.store.getState();f.db.close();
  inspect(f.db.filePath,raw=>raw.exec('DROP TABLE trade_attempts; DROP TABLE price_history; DROP TABLE sync_tasks; DROP INDEX products_favorite; DROP INDEX cart_card; DELETE FROM schema_migrations WHERE version>=3; PRAGMA user_version=2;'));
  const next=open(f.config);assert.deepEqual(next.store.getState(),before);assert.equal(next.db.queryProducts(DEFAULT_PRODUCT_QUERY).total,1);
  assert.ok(readdirSync(join(f.config.directory,'backups')).some(name=>name.startsWith(`before-schema-v2-to-v${DATABASE_VERSION}-`)));
});

const tradeAttempt=(cardId:string):TradeAttempt=>({id:'fixture-trade-attempt',cardId,cardKey:'a'.repeat(64),fingerprint:'b'.repeat(64),previewDigest:'c'.repeat(64),status:'unknown',startedAt:'2026-10-09T00:00:00Z',updatedAt:'2026-10-09T00:00:01Z',deduction:12,balanceUnit:'额度',lines:[{productCode:'private-trade-product',skuCode:'private-trade-sku',inventoryId:'private-pool',name:'私密测试商品',specification:'规格',quantity:1,price:12}],orderCode:'private-trade-order',sellerOrderCode:null,message:'结果待核对',baselineOrders:[]});

test('schema v3 migrates transactionally to encrypted trade records and preserves the old vault',()=>{
  const f=open(),id=seed(f.store),before=f.store.getState();f.db.close();
  inspect(f.db.filePath,db=>db.exec('DROP TABLE trade_attempts; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3;'));
  const next=open(f.config);assert.deepEqual(next.store.getState(),before);assert.deepEqual(next.db.tradeAttempts(),[]);
  const backup=readdirSync(join(f.config.directory,'backups')).find(name=>name.startsWith('before-schema-v3-to-v4-'))!;
  inspect(join(f.config.directory,'backups',backup),db=>{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,3);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards').get()!.n,1);});
  next.db.saveTradeAttempt(tradeAttempt(id));
  for(const file of [next.db.filePath,next.db.filePath+'-wal'])if(readFileSync(file).length)for(const text of ['private-trade-order','private-trade-sku','私密测试商品'])assert.equal(readFileSync(file).includes(Buffer.from(text)),false);
});
test('trade records survive backup transfer, old-card restore and encryption failures without losing uncertain intents',()=>{
  const f=open(),id=seed(f.store),management=f.db.managementData();delete management.tradeAttempts;
  const legacy=f.store.exportBackup('portable-password',f.addresses.list(),management);assert.equal(JSON.parse(legacy).version,3);
  f.db.saveTradeAttempt(tradeAttempt(id));
  const backup=f.backups.export('portable-password');assert.equal(JSON.parse(backup).version,4);
  const destination=open();destination.backups.apply(destination.backups.prepare(backup,'portable-password'));assert.deepEqual(destination.db.tradeAttempts(),[tradeAttempt(id)]);
  destination.backups.apply(destination.backups.prepare(legacy,'portable-password'));assert.deepEqual(destination.db.tradeAttempts(),[tradeAttempt(id)],'restoring a stale backup cannot delete an uncertain order');
  const before=destination.db.tradeAttempts();
  const brokenConfig={...destination.config,encryptString:()=>{throw new Error('synthetic keychain failure');}};
  const broken=new SqliteRepository(brokenConfig);databases.push(broken);assert.throws(()=>broken.saveTradeAttempt({...tradeAttempt(id),message:'cannot persist'}),/keychain failure/);assert.deepEqual(destination.db.tradeAttempts(),before);
});
test('unreleased v4 migration failure restores v3 and a retry can complete',()=>{
  const f=open();seed(f.store);const before=f.store.getState();f.db.close();
  inspect(f.db.filePath,db=>db.exec('DROP TABLE trade_attempts; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3; CREATE TABLE trade_attempts (id TEXT PRIMARY KEY);'));
  assert.throws(()=>openStorage(f.config),/already exists/);
  inspect(f.db.filePath,db=>{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,3);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n,3);db.exec('DROP TABLE trade_attempts');});
  assert.deepEqual(open(f.config).store.getState(),before);
});

test('restoring a newer backup adds order references to an earlier uncertain attempt without trusting backup success',()=>{
  const f=open(),id=seed(f.store),initial={...tradeAttempt(id),status:'submitting' as const,orderCode:null,sellerOrderCode:null};
  f.db.saveTradeAttempt(initial);const early=f.backups.export('portable-password');
  const final={...initial,status:'succeeded' as const,orderCode:'confirmed-fixture-order',sellerOrderCode:'confirmed-fixture-seller',updatedAt:'2026-10-09T00:00:02Z'};
  f.db.saveTradeAttempt(final);const recent=f.backups.export('portable-password');
  const destination=open();destination.backups.apply(destination.backups.prepare(early,'portable-password'));
  const recovered=destination.db.tradeAttempts()[0];assert.equal(recovered.status,'unknown');assert.equal(recovered.orderCode,null);
  assert.ok(Date.parse(recovered.updatedAt)>Date.parse(final.updatedAt),'recovery timestamps must not suppress newer order evidence');
  destination.backups.apply(destination.backups.prepare(recent,'portable-password'));
  const merged=destination.db.tradeAttempts()[0];assert.equal(merged.orderCode,final.orderCode);assert.equal(merged.sellerOrderCode,final.sellerOrderCode);assert.equal(merged.status,'submitted','a server query must confirm the imported result');
  destination.backups.apply(destination.backups.prepare(early,'portable-password'));
  assert.equal(destination.db.tradeAttempts()[0].orderCode,final.orderCode,'old backups cannot erase the new reference');
});

test('conflicting transaction identity or order evidence rejects restoration without replacing current domains',()=>{
  for(const patch of [{cardKey:'d'.repeat(64)},{fingerprint:'e'.repeat(64)},{orderCode:'conflicting-fixture-order'},{sellerOrderCode:'conflicting-fixture-seller'}]){
    const source=open(),id=seed(source.store),original={...tradeAttempt(id),sellerOrderCode:'original-fixture-seller'};
    source.db.saveTradeAttempt(original);const destination=open();destination.backups.apply(destination.backups.prepare(source.backups.export('portable-password'),'portable-password'));
    const state=destination.store.getState(),book=destination.addresses.list(),records=destination.db.tradeAttempts();
    source.db.saveTradeAttempt({...original,...patch});
    const conflict=destination.backups.prepare(source.backups.export('portable-password'),'portable-password');
    assert.throws(()=>destination.backups.apply(conflict),/冲突/);
    assert.deepEqual(destination.store.getState(),state);assert.deepEqual(destination.addresses.list(),book);assert.deepEqual(destination.db.tradeAttempts(),records);
  }
});
