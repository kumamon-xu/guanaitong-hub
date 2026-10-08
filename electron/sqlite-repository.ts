import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { AppState, Card, Product, ProductOffer, Order, Activity } from '../src/shared/types';
import type { LocalAddress } from './addresses';
import type { AddressRepository, EncryptionOptions, HubRepository, PortableData, SessionRepository } from './persistence';
import { privateDirectory, regularFile } from './legacy-storage';
import { DATABASE_MIGRATIONS, DATABASE_VERSION } from './database-migrations';
import type { ProductQuery, ProductPage, OrderQuery, OrderPage, SyncTask, PriceHistory, ManagementData } from '../src/shared/operations';
import { sourceCategories, validateProductQuery, validateOrderQuery } from '../src/shared/queries';

export class SqliteRepository implements HubRepository, AddressRepository, SessionRepository {
  readonly filePath: string;
  readonly directory: string;
  private readonly db: DatabaseSync;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lastHub:PortableData|null=null;
  private encryptedCache=new Map<string,{text:string;bytes:Buffer}>();
  private sqlCache=new Map<string,Map<string,SQLInputValue[]>>();
  private queryDirty=true;
  private productCache=new Map<string,Product>();
  private orderCache=new Map<string,Order>();
  private historySources:Set<string>|null=null;

  constructor(private readonly options: EncryptionOptions) {
    this.directory = privateDirectory(options.directory);
    this.filePath = join(this.directory, 'hub.sqlite');
    if (existsSync(this.filePath)) regularFile(this.filePath);
    this.db = new DatabaseSync(this.filePath, { enableForeignKeyConstraints: true, timeout: 5000 });
    chmodSync(this.filePath, 0o600);
    try {
      this.assertIntegrity();
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > DATABASE_VERSION) throw new Error('数据库由较新版本创建，请使用新版卡管家；原数据库未修改');
      if (version > 0) {
        const history = this.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
        if (history.length !== version || history.some((row, i) => row.version !== i + 1 || row.name !== DATABASE_MIGRATIONS[i]?.name)) throw new Error('数据库迁移记录不一致，原数据已保留');
      } else if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) {
        throw new Error('数据库版本缺失，原数据已保留');
      }
      if (version < DATABASE_VERSION) {
        if (version) this.backup(`before-schema-v${version}-to-v${DATABASE_VERSION}`);
        this.transaction(() => {
          for (const migration of DATABASE_MIGRATIONS.filter(item => item.version > version)) {
            this.db.exec(migration.sql);
            this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString());
            this.db.exec(`PRAGMA user_version=${migration.version}`);
          }
        });
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
      this.privateFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** A single application writer; a rejected mutation cannot poison following jobs. */
  enqueueWrite<T>(work: () => T): Promise<T> {
    const result = this.pending.catch(() => {}).then(() => {
      if (this.closed) throw new Error('数据库已关闭');
      return work();
    });
    this.pending = result;
    return result;
  }
  async flush(): Promise<void> { await this.pending.catch(() => {}); }
  close(): void {
    if (this.closed) return;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close(); this.closed = true;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = work();
      this.db.exec('COMMIT'); committed = true;
      return result;
    } finally {
      if (!committed) this.db.exec('ROLLBACK');
    }
  }
  private encrypt(value: unknown): Buffer {
    const result = this.options.encryptString(JSON.stringify(value));
    if (!Buffer.isBuffer(result) || !result.length) throw new Error('系统安全存储加密失败，现有数据未改变');
    return result;
  }
  private cachedEncrypt(key:string,value:unknown):Buffer{
    const text=JSON.stringify(value),old=this.encryptedCache.get(key);
    if(old?.text===text)return old.bytes;
    const bytes=this.encrypt(value);this.encryptedCache.set(key,{text,bytes});return bytes;
  }
  private decrypt<T>(value: unknown): T {
    if (!(value instanceof Uint8Array) || !value.length) throw new Error('数据库加密字段无效');
    try { return JSON.parse(this.options.decryptString(Buffer.from(value))) as T; }
    catch { throw new Error('数据库无法解密或已损坏，请在原设备导出备份，或恢复口令备份；原数据已保留'); }
  }
  private privateFiles(): void {
    for (const path of [this.filePath, this.filePath + '-wal', this.filePath + '-shm']) if (existsSync(path)) chmodSync(path, 0o600);
  }
  assertIntegrity(): void {
    const rows = this.db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || rows[0].quick_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库完整性检查失败，请从备份恢复；原文件已保留');
  }
  initialized(): boolean { return this.db.prepare("SELECT value FROM storage_meta WHERE key='initialized'").get()?.value === '1'; }
  private markInitialized(): void { this.db.prepare("INSERT OR REPLACE INTO storage_meta VALUES ('initialized', '1')").run(); }

  loadHub(): PortableData | null {
    const settings = this.db.prepare('SELECT payload FROM settings WHERE id=1').get();
    if (!settings) return null;
    const credentialEntries: [string, PortableData['credentials'][string]][] = [];
    const cards = this.db.prepare('SELECT * FROM cards ORDER BY position').all().map(row => {
      const credential = this.decrypt<PortableData['credentials'][string]>(row.credential);
      credentialEntries.push([String(row.id), credential]);
      const card = this.decrypt<Omit<Card, 'number'>>(row.payload);
      return { ...card, id: String(row.id), number: credential.number, balance: row.balance as number | null, archived: !!row.archived };
    });
    const products = this.db.prepare('SELECT * FROM products ORDER BY position').all().map(row => ({
      ...this.decrypt<Omit<Product, 'offers'>>(row.payload), id: String(row.id), favorite: !!row.favorite, offers: [] as ProductOffer[],
    }));
    const byId = new Map(products.map(product => [product.id, product]));
    for (const row of this.db.prepare('SELECT * FROM offers ORDER BY product_id, position').all()) byId.get(String(row.product_id))!.offers.push({
      ...this.decrypt<ProductOffer>(row.payload), cardId: String(row.card_id), sourceId: String(row.source_id), price: row.price as number | null, stock: row.stock as number | null,
    });
    const orders = this.db.prepare('SELECT * FROM orders ORDER BY position').all().map(row => ({
      ...this.decrypt<Order>(row.payload), id: String(row.id), cardId: String(row.card_id), sourceId: String(row.source_id), amount: row.amount as number | null,
    }));
    const cart = this.db.prepare('SELECT * FROM cart ORDER BY position').all().map(row => ({ id: String(row.id), cardId: String(row.card_id), productId: String(row.product_id), sourceId: String(row.source_id), quantity: Number(row.quantity) }));
    const activities = this.db.prepare('SELECT * FROM activities ORDER BY position').all().map(row => this.decrypt<Activity>(row.payload));
    const manualMerges = Object.fromEntries(this.db.prepare('SELECT * FROM manual_merges ORDER BY position').all().map(row => [this.decrypt<string>(row.payload), String(row.product_id)]));
    const data={ state: { cards, products, orders, cart, activities, settings: this.decrypt<AppState['settings']>(settings.payload), version: 1 }, credentials: Object.fromEntries(credentialEntries), manualMerges };
    this.lastHub=data;this.queryDirty=true;this.sqlCache.clear();
    return data;
  }
  private encodeHub(data: PortableData) {
    return {
      cards: data.state.cards.map(({ number: _number, ...card }) => ({ card, payload: this.cachedEncrypt('card:'+card.id,card), credential: this.cachedEncrypt('credential:'+card.id,data.credentials[card.id]) })),
      products: data.state.products.map(({ offers, ...product }) => ({ product, payload: this.cachedEncrypt('product:'+product.id,product), offers: offers.map(offer => ({ offer, payload: this.cachedEncrypt('offer:'+JSON.stringify([offer.cardId,offer.sourceId]),offer) })) })),
      orders: data.state.orders.map(order => ({ order, payload: this.cachedEncrypt('order:'+order.id,order) })),
      activities: data.state.activities.map(activity => ({ activity, payload: this.cachedEncrypt('activity:'+activity.id,activity) })),
      merges: Object.entries(data.manualMerges).map(([key, id]) => ({ id, payload: this.cachedEncrypt('merge:'+key,key) })),
      settings: this.cachedEncrypt('settings',data.state.settings), cart: data.state.cart,
    };
  }
  private writeHub(data: ReturnType<SqliteRepository['encodeHub']>, clearSessions=false): Map<string,Map<string,SQLInputValue[]>> {
    if(clearSessions)this.db.exec('DELETE FROM sessions; DELETE FROM price_history; DELETE FROM sync_tasks;');
    const specs:{name:string;columns:string[];keys:string[];rows:SQLInputValue[][]}[]=[
      {name:'cards',columns:['id','position','balance','archived','payload','credential'],keys:['id'],rows:data.cards.map(({card,payload,credential},i)=>[card.id,i,card.balance,+card.archived,payload,credential])},
      {name:'products',columns:['id','position','favorite','payload'],keys:['id'],rows:data.products.map(({product,payload},i)=>[product.id,i,+product.favorite,payload])},
      {name:'offers',columns:['card_id','source_id','product_id','position','price','stock','payload'],keys:['card_id','source_id'],rows:data.products.flatMap(({product,offers})=>offers.map(({offer,payload},i)=>[offer.cardId,offer.sourceId,product.id,i,offer.price,offer.stock,payload]))},
      {name:'orders',columns:['id','card_id','source_id','position','amount','payload'],keys:['id'],rows:data.orders.map(({order,payload},i)=>[order.id,order.cardId,order.sourceId,i,order.amount,payload])},
      {name:'cart',columns:['id','card_id','product_id','source_id','position','quantity'],keys:['id'],rows:data.cart.map((item,i)=>[item.id,item.cardId,item.productId,item.sourceId,i,item.quantity])},
      {name:'activities',columns:['id','card_id','position','payload'],keys:['id'],rows:data.activities.map(({activity,payload},i)=>[activity.id,activity.cardId??null,i,payload])},
      {name:'manual_merges',columns:['position','product_id','payload'],keys:['position'],rows:data.merges.map(({id,payload},i)=>[i,id,payload])},
      {name:'settings',columns:['id','payload'],keys:['id'],rows:[[1,data.settings]]},
    ];
    const key=(columns:string[],keys:string[],row:SQLInputValue[])=>JSON.stringify(keys.map(field=>row[columns.indexOf(field)]));
    const next=new Map<string,Map<string,SQLInputValue[]>>();
    const previous=new Map<string,Map<string,SQLInputValue[]>>();
    for(const spec of specs){
      const current=new Map(spec.rows.map(row=>[key(spec.columns,spec.keys,row),row]));next.set(spec.name,current);
      const old=this.sqlCache.get(spec.name)??new Map(this.db.prepare('SELECT '+spec.columns.join(',')+' FROM '+spec.name).all().map(row=>{const values=spec.columns.map(col=>row[col] as SQLInputValue);return[key(spec.columns,spec.keys,values),values];}));previous.set(spec.name,old);
    }
    for(const spec of specs.filter(item=>!['cards','products'].includes(item.name))){
      const stmt=this.db.prepare('DELETE FROM '+spec.name+' WHERE '+spec.keys.map(field=>field+'=?').join(' AND '));
      for(const [id,row] of previous.get(spec.name)!)if(!next.get(spec.name)!.has(id))stmt.run(...spec.keys.map(field=>row[spec.columns.indexOf(field)]));
    }
    for(const spec of specs){
      const old=previous.get(spec.name)!,pos=spec.columns.indexOf('position');
      const move=pos>=0&&!spec.keys.includes('position')&&(old.size!==spec.rows.length||spec.rows.some(row=>{const prior=old.get(key(spec.columns,spec.keys,row));return prior?(prior[pos]!==row[pos]||(spec.name==='offers'&&prior[2]!==row[2])):old.size>0;}));
      if(move)this.db.exec('UPDATE '+spec.name+' SET position=-position-1');
      const stmt=this.db.prepare('INSERT INTO '+spec.name+' ('+spec.columns.join(',')+') VALUES ('+spec.columns.map(()=>'?').join(',')+') ON CONFLICT('+spec.keys.join(',')+') DO UPDATE SET '+spec.columns.filter(col=>!spec.keys.includes(col)).map(col=>col+'=excluded.'+col).join(','));
      for(const row of spec.rows){
        const prior=old.get(key(spec.columns,spec.keys,row));
        const same=prior&&row.every((value,i)=>value instanceof Uint8Array&&prior[i] instanceof Uint8Array?Buffer.from(value).equals(Buffer.from(prior[i] as Uint8Array)):value===prior[i]);
        if(!same||move)stmt.run(...row);
      }
    }
    for(const spec of specs.filter(item=>['products','cards'].includes(item.name)).reverse()){
      const stmt=this.db.prepare('DELETE FROM '+spec.name+' WHERE id=?');
      for(const [id,row] of previous.get(spec.name)!)if(!next.get(spec.name)!.has(id))stmt.run(row[0]);
    }
    return next;
  }
  saveHub(data: PortableData): void {
    const encoded=this.encodeHub(data);
    const previous=this.lastHub;
    const knownHistory=this.historySources??new Set(this.db.prepare('SELECT DISTINCT card_id,source_id FROM price_history').all().map(row=>JSON.stringify([row.card_id,row.source_id])));
    const addedHistory:string[]=[];
    const next=this.transaction(()=>{
      if(previous){
        const oldOffers=new Map(previous.state.products.flatMap(product=>product.offers.map(offer=>[JSON.stringify([offer.cardId,offer.sourceId]),offer] as const)));
        const insert=this.db.prepare('INSERT INTO price_history VALUES (?, ?, ?, ?, ?)');
        for(const product of data.state.products)for(const offer of product.offers){
          const old=oldOffers.get(JSON.stringify([offer.cardId,offer.sourceId]));
          const source=JSON.stringify([offer.cardId,offer.sourceId]);
          if(!old||old.price!==offer.price||old.priceUnit!==offer.priceUnit||!knownHistory.has(source)){
            const history:PriceHistory={id:randomUUID(),cardId:offer.cardId,sourceId:offer.sourceId,at:Number.isFinite(Date.parse(offer.syncedAt))?offer.syncedAt:new Date().toISOString(),price:offer.price,unit:offer.priceUnit};
            insert.run(history.id,history.cardId,history.sourceId,history.at,this.encrypt(history));
            addedHistory.push(source);
          }
        }
      }
      return this.writeHub(encoded);
    });
    this.sqlCache=next;
    this.historySources=new Set([...knownHistory,...addedHistory]);
    this.queryDirty=this.queryDirty||!previous||JSON.stringify(previous.state.products)!==JSON.stringify(data.state.products)||JSON.stringify(previous.state.orders)!==JSON.stringify(data.state.orders)||JSON.stringify(previous.state.cards.map(card=>[card.id,card.archived,card.status]))!==JSON.stringify(data.state.cards.map(card=>[card.id,card.archived,card.status]));
    this.lastHub=data;
    const activeKeys=new Set(['settings',...data.state.cards.flatMap(card=>['card:'+card.id,'credential:'+card.id]),...data.state.products.flatMap(product=>['product:'+product.id,...product.offers.map(offer=>'offer:'+JSON.stringify([offer.cardId,offer.sourceId]))]),...data.state.orders.map(item=>'order:'+item.id),...data.state.activities.map(item=>'activity:'+item.id),...Object.keys(data.manualMerges).map(key=>'merge:'+key)]);
    for(const key of this.encryptedCache.keys())if(!activeKeys.has(key))this.encryptedCache.delete(key);
  }
  loadAddresses(): LocalAddress[] {
    return this.db.prepare('SELECT * FROM addresses ORDER BY position').all().map(row => ({ ...this.decrypt<LocalAddress>(row.payload), id: String(row.id), isDefault: !!row.is_default }));
  }
  private buildQueryIndex():void{
    if(!this.queryDirty)return;
    const data=this.lastHub??this.loadHub();if(!data)return;
    // Searchable private text lives only in SQLite TEMP memory, never in the database/WAL.
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS hub_products(id TEXT PRIMARY KEY, search TEXT, position INTEGER, favorite INTEGER);
      CREATE TEMP TABLE IF NOT EXISTS hub_offers(product_id TEXT, card_id TEXT, source_id TEXT, price REAL, unit TEXT, available INTEGER);
      CREATE INDEX IF NOT EXISTS temp.hub_offers_product ON hub_offers(product_id);
      CREATE INDEX IF NOT EXISTS temp.hub_offers_card_price ON hub_offers(card_id, price, product_id);
      CREATE TEMP TABLE IF NOT EXISTS hub_categories(product_id TEXT,card_id TEXT,source_id TEXT,name TEXT);
      CREATE INDEX IF NOT EXISTS temp.hub_category_name ON hub_categories(name, product_id,card_id,source_id);
      CREATE TEMP TABLE IF NOT EXISTS hub_orders(id TEXT PRIMARY KEY,card_id TEXT,search TEXT,status TEXT,created INTEGER);
      CREATE INDEX IF NOT EXISTS temp.hub_orders_filter ON hub_orders(card_id,status,created DESC);
      DELETE FROM hub_products;DELETE FROM hub_offers;DELETE FROM hub_categories;DELETE FROM hub_orders;
    `);
    const cards=new Map(data.state.cards.map(card=>[card.id,card]));
    const productStmt=this.db.prepare('INSERT INTO hub_products VALUES (?, ?, ?, ?)');
    const offerStmt=this.db.prepare('INSERT INTO hub_offers VALUES (?, ?, ?, ?, ?, ?)');
    const categoryStmt=this.db.prepare('INSERT INTO hub_categories VALUES (?, ?, ?, ?)');
    this.productCache=new Map(data.state.products.map(product=>[product.id,product]));
    data.state.products.forEach((product,i)=>{
      productStmt.run(product.id,`${product.name} ${product.brand} ${product.specification}`.toLowerCase(),i,+product.favorite);
      if(!product.offers.length)for(const name of new Set(sourceCategories(product)))categoryStmt.run(product.id,null,null,name);
      for(const offer of product.offers){
        const card=cards.get(offer.cardId);const available=!!card&&!card.archived&&!['expired','exhausted'].includes(card.status)&&offer.stock!==0;
        offerStmt.run(product.id,offer.cardId,offer.sourceId,offer.price,offer.priceUnit.trim()||'未标注单位',+available);
        for(const name of new Set(sourceCategories(product,offer)))categoryStmt.run(product.id,offer.cardId,offer.sourceId,name);
      }
    });
    const orderStmt=this.db.prepare('INSERT INTO hub_orders VALUES (?, ?, ?, ?, ?)');
    this.orderCache=new Map(data.state.orders.map(order=>[order.id,order]));
    for(const order of data.state.orders)orderStmt.run(order.id,order.cardId,`${order.name} ${order.sourceId} ${order.tracking}`.toLowerCase(),order.status,Number.isFinite(Date.parse(order.createdAt))?Date.parse(order.createdAt):null);
    this.queryDirty=false;
  }
  queryProducts(query:ProductQuery):ProductPage{
    const q=validateProductQuery(query);this.buildQueryIndex();
    const clauses:string[]=[],params:SQLInputValue[]=[];
    if(q.cardId!=='all'){clauses.push('o.card_id=?');params.push(q.cardId);}
    if(q.price.unit!=='all'){clauses.push('o.unit=?');params.push(q.price.unit);}
    if(q.price.amounts.length){clauses.push('o.price IN ('+q.price.amounts.map(()=>'?').join(',')+')');params.push(...q.price.amounts);}
    const base=clauses.length?' AND '+clauses.join(' AND '):'';
    const facetRows=this.db.prepare('SELECT c.name,COUNT(DISTINCT p.id) AS count FROM hub_products p LEFT JOIN hub_offers o ON o.product_id=p.id JOIN hub_categories c ON c.product_id=p.id AND c.card_id IS o.card_id AND c.source_id IS o.source_id WHERE 1=1'+base+' GROUP BY c.name ORDER BY c.name').all(...params);
    const all=Number(this.db.prepare('SELECT COUNT(DISTINCT p.id) AS n FROM hub_products p LEFT JOIN hub_offers o ON o.product_id=p.id WHERE 1=1'+base).get(...params)!.n);
    if(q.category!=='全部分类'){clauses.push('EXISTS (SELECT 1 FROM hub_categories c WHERE c.product_id=p.id AND c.card_id IS o.card_id AND c.source_id IS o.source_id AND c.name=?)');params.push(q.category);}
    if(q.favoritesOnly)clauses.push('p.favorite=1');
    if(q.search.trim()){clauses.push('instr(p.search,?)>0');params.push(q.search.trim().toLowerCase());}
    const where=clauses.length?' AND '+clauses.join(' AND '):'';
    const groups=' FROM hub_products p LEFT JOIN hub_offers o ON o.product_id=p.id WHERE 1=1'+where+' GROUP BY p.id';
    const total=Number(this.db.prepare('SELECT COUNT(*) AS n FROM (SELECT p.id'+groups+')').get(...params)!.n);
    const sort=q.price.sort==='default'?'p.position':'display_price IS NULL,display_price '+(q.price.sort==='descending'?'DESC':'ASC')+',p.position';
    const rows=this.db.prepare('SELECT p.id, MIN(CASE WHEN o.available=1 THEN o.price END) AS display_price'+groups+' ORDER BY '+sort+' LIMIT ? OFFSET ?').all(...params,q.pageSize,(q.page-1)*q.pageSize);
    const scope=q.cardId==='all'?'':' WHERE card_id=?',scopeParams=q.cardId==='all'?[]:[q.cardId];
    const units=this.db.prepare('SELECT DISTINCT unit FROM hub_offers'+scope+' ORDER BY unit').all(...scopeParams).map(row=>String(row.unit));
    const amountClauses=['price IS NOT NULL'],amountParams:SQLInputValue[]=[];
    if(q.cardId!=='all'){amountClauses.push('card_id=?');amountParams.push(q.cardId);}
    if(q.price.unit!=='all'){amountClauses.push('unit=?');amountParams.push(q.price.unit);}
    const amounts=this.db.prepare('SELECT DISTINCT price FROM hub_offers WHERE '+amountClauses.join(' AND ')+' ORDER BY price').all(...amountParams).map(row=>Number(row.price));
    return {items:rows.map(row=>structuredClone(this.productCache.get(String(row.id))!)),total,page:q.page,pageSize:q.pageSize,categories:[{name:'全部分类',count:all},...facetRows.map(row=>({name:String(row.name),count:Number(row.count)}))],units,amounts};
  }
  queryOrders(query:OrderQuery):OrderPage{
    const q=validateOrderQuery(query);this.buildQueryIndex();
    const clauses:string[]=[],params:SQLInputValue[]=[];
    if(q.cardId!=='all'){clauses.push('card_id=?');params.push(q.cardId);}
    if(q.status!=='all'){clauses.push('status=?');params.push(q.status);}
    if(q.search.trim()){clauses.push('instr(search,?)>0');params.push(q.search.trim().toLowerCase());}
    if(q.from){clauses.push('created>=?');params.push(Date.parse(q.from+'T00:00:00+08:00'));}
    if(q.to){clauses.push('created<=?');params.push(Date.parse(q.to+'T23:59:59.999+08:00'));}
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    const total=Number(this.db.prepare('SELECT COUNT(*) AS n FROM hub_orders'+where).get(...params)!.n);
    const rows=this.db.prepare('SELECT id FROM hub_orders'+where+' ORDER BY created DESC,id LIMIT ? OFFSET ?').all(...params,q.pageSize,(q.page-1)*q.pageSize);
    return {items:rows.map(row=>structuredClone(this.orderCache.get(String(row.id))!)),total,page:q.page,pageSize:q.pageSize,statuses:this.db.prepare('SELECT DISTINCT status FROM hub_orders ORDER BY status').all().map(row=>String(row.status))};
  }
  saveSyncTask(task:SyncTask):void{
    const payload=this.encrypt(task);
    this.transaction(()=>{
      this.db.prepare('INSERT INTO sync_tasks VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(task.id,task.cardId,task.startedAt,payload);
      this.db.exec('DELETE FROM sync_tasks WHERE id NOT IN (SELECT id FROM sync_tasks ORDER BY at DESC LIMIT 1000)');
    });
  }
  syncTasks():SyncTask[]{return this.db.prepare('SELECT payload FROM sync_tasks ORDER BY at DESC LIMIT 100').all().map(row=>this.decrypt<SyncTask>(row.payload));}
  recoverInterruptedTasks():SyncTask[]{
    const tasks=this.syncTasks();
    for(const task of tasks)if(['queued','running'].includes(task.status)){Object.assign(task,{status:'interrupted',finishedAt:new Date().toISOString(),message:'程序退出中断，可重试该卡',errorKind:'unknown'});this.saveSyncTask(task);}
    return this.syncTasks();
  }
  priceHistory(cardId:string,sourceId:string):PriceHistory[]{return this.db.prepare('SELECT payload FROM price_history WHERE card_id=? AND source_id=? ORDER BY at DESC,rowid DESC LIMIT 100').all(cardId,sourceId).map(row=>this.decrypt<PriceHistory>(row.payload));}
  managementData():ManagementData{
    return {priceHistory:this.db.prepare('SELECT payload FROM price_history ORDER BY at,rowid').all().map(row=>this.decrypt<PriceHistory>(row.payload)),syncTasks:this.db.prepare('SELECT payload FROM sync_tasks ORDER BY at,rowid').all().map(row=>this.decrypt<SyncTask>(row.payload))};
  }
  private encodeAddresses(addresses: LocalAddress[]) { return addresses.map(address => ({ address, payload: this.encrypt(address) })); }
  private writeAddresses(data: ReturnType<SqliteRepository['encodeAddresses']>): void {
    this.db.exec('DELETE FROM addresses');
    const stmt = this.db.prepare('INSERT INTO addresses VALUES (?, ?, ?, ?)');
    data.forEach(({ address, payload }, i) => stmt.run(address.id, i, +address.isDefault, payload));
  }
  saveAddresses(addresses: LocalAddress[]): void {
    const encoded = this.encodeAddresses(addresses);
    this.transaction(() => this.writeAddresses(encoded));
  }
  filePathForSession(id: string): string {
    if (typeof id !== 'string' || !id || id.length > 512) throw new Error('卡片会话标识无效');
    return this.filePath;
  }
  loadSession(id: string): unknown | null {
    this.filePathForSession(id);
    const row = this.db.prepare('SELECT payload FROM sessions WHERE card_id=?').get(id);
    return row ? this.decrypt(row.payload) : null;
  }
  saveSession(id: string, encrypted: Buffer): Promise<void> {
    this.filePathForSession(id);
    return this.enqueueWrite(()=>{this.transaction(() => this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?)').run(id, encrypted));});
  }
  /** Migration marker, rows and relationships are committed together. */
  initialize(data: PortableData, addresses: LocalAddress[], sessions: Map<string, unknown>, legacyBackup?: string): void {
    const hub = this.encodeHub(data), book = this.encodeAddresses(addresses);
    const cookies = [...sessions].map(([id, value]) => [id, this.encrypt(value)] as const);
    this.transaction(() => {
      this.writeHub(hub, true); this.writeAddresses(book);
      const insert = this.db.prepare('INSERT INTO sessions VALUES (?, ?)');
      for (const [id, bytes] of cookies) insert.run(id, bytes);
      // Decryption, exact equality and foreign keys are checked before marking success.
      if (!isDeepStrictEqual(this.loadHub(), data) || !isDeepStrictEqual(this.loadAddresses(), addresses)) throw new Error('旧数据迁移核对失败，原文件已保留');
      for (const [id, value] of sessions) if (!isDeepStrictEqual(this.loadSession(id), value)) throw new Error('旧会话迁移核对失败，原文件已保留');
      this.assertIntegrity(); this.markInitialized();
      if (legacyBackup) this.db.prepare("INSERT OR REPLACE INTO storage_meta VALUES ('legacy_backup', ?)").run(legacyBackup);
    });
  }
  /** Validated portable data is re-encrypted before any destructive SQL executes. */
  restore(data: PortableData | null, addresses: LocalAddress[] | null, management:ManagementData|null=null): void {
    const hub = data ? this.encodeHub(data) : null;
    const book = addresses ? this.encodeAddresses(addresses) : null;
    this.backup('before-restore');
    this.transaction(() => {
      if (hub) this.writeHub(hub, true);
      if (book) this.writeAddresses(book);
      if(data&&management){
        const history=this.db.prepare('INSERT INTO price_history VALUES (?, ?, ?, ?, ?)');
        for(const item of management.priceHistory)history.run(item.id,item.cardId,item.sourceId,item.at,this.encrypt(item));
        const tasks=this.db.prepare('INSERT INTO sync_tasks VALUES (?, ?, ?, ?)');
        for(const task of management.syncTasks){const item=['queued','running'].includes(task.status)?{...task,status:'interrupted',finishedAt:new Date().toISOString(),message:'恢复的未完成任务，可重新同步'}:task;tasks.run(item.id,item.cardId,item.startedAt,this.encrypt(item));}
      }
      this.assertIntegrity();
    });
    this.sqlCache.clear();this.lastHub=null;this.queryDirty=true;this.encryptedCache.clear();this.historySources=null;
  }
  /** VACUUM INTO captures WAL commits too; copying only the live .sqlite file would not. */
  backup(reason: string): string {
    if (!/^[a-z0-9-]{1,80}$/.test(reason)) throw new Error('数据库备份标识无效');
    const folder = privateDirectory(join(this.directory, 'backups'));
    const path = join(folder, `${reason}-${Date.now()}-${randomUUID()}.sqlite`);
    try {
      this.db.prepare('VACUUM INTO ?').run(path);
      chmodSync(path, 0o600);
      const fd = openSync(path, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return path;
    } catch (error) {
      if (existsSync(path)) unlinkSync(path);
      throw error;
    }
  }
}
