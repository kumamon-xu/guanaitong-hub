import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { SyncManager } from '../electron/sync-manager';
import { readOfficial,OfficialFailure } from '../electron/official-client';
import { LoginRequired,fetchSnapshot } from '../electron/adapter';
import { validateIPC } from '../electron/ipc-validation';
import { ReleaseService,compareVersions } from '../electron/release-service';
import { exportOrderCSV } from '../electron/order-export';
import { expiryReminders,budgetSummary } from '../src/shared/management';
import { virtualWindow } from '../src/shared/virtual-window';
import { DEFAULT_PRODUCT_QUERY } from '../src/shared/operations';
import type { Card,Product,Order } from '../src/shared/types';
import type { SqliteRepository } from '../electron/sqlite-repository';

const card:Card={id:'fixture',number:'123456789012',label:'卡',balance:100,balanceUnit:'元',status:'active',addedAt:'2026-10-01T00:00:00.000Z',expiresAt:null,syncedAt:null,archived:false,note:'',error:null,productCount:0,hasPassword:true};
const fetcher=(work:(input:unknown,init?:RequestInit)=>Promise<Response>)=>work as typeof fetch;
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};

test('sync scheduler enforces concurrency, shares a card run and records one batch',async()=>{
  let active=0,maximum=0;const hold=gate(),manager=new SyncManager({concurrency:()=>2,persist:()=>{},changed:()=>{}});
  const run=async(id:string)=>{active++;maximum=Math.max(maximum,active);await hold.promise;active--;return{cardId:id,ok:true,message:'完成'};};
  const first=manager.run('a',()=>run('a'));assert.equal(manager.run('a',()=>{throw new Error('must not duplicate');}),first);
  const batch=manager.all(['b','c'],id=>run(id));assert.equal(maximum,2);assert.equal(manager.list().find(task=>task.cardId==='c')!.status,'queued');
  hold.release();await Promise.all([first,batch]);assert.equal(maximum,2);assert.ok(manager.list().every(task=>task.status==='succeeded'));
  assert.equal(new Set(manager.list().filter(task=>task.cardId!=='a').map(task=>task.batchId)).size,1);
});

test('queued cancellation resolves immediately, running cancellation and failure do not poison later jobs',async()=>{
  const manager=new SyncManager({concurrency:()=>1,persist:()=>{},changed:()=>{}}),hold=gate();
  const running=manager.run('a',async context=>{await hold.promise;context.signal.throwIfAborted();return{cardId:'a',ok:true,message:'完成'};});
  let queuedStarted=false;const queued=manager.run('b',async()=>{queuedStarted=true;return{cardId:'b',ok:true,message:'错误'};});
  manager.cancel('b');assert.equal((await queued).cancelled,true);assert.equal(queuedStarted,false);
  manager.cancel('a');hold.release();assert.equal((await running).cancelled,true);
  await manager.run('c',async context=>{context.progress('orders',3,40,80);throw new OfficialFailure('schema','exchangeOrder/list','响应变化');});
  const failure=manager.list().find(task=>task.cardId==='c')!;assert.equal(failure.errorKind,'schema');assert.equal(failure.phase,'orders');assert.equal(failure.endpoint,'exchangeOrder/list');
  assert.equal((await manager.run('d',async()=>({cardId:'d',ok:true,message:'恢复'}))).ok,true);
});

test('official reads reject unapproved writes and malformed responses without exposing bodies',async()=>{
  let calls=0;const mock=fetcher(async()=>{calls++;return new Response('<html>password=secret</html>',{status:200});});
  await assert.rejects(readOfficial(mock,'address/add',{},'POST'),/允许范围/);assert.equal(calls,0);
  await assert.rejects(readOfficial(mock,'product/list'),error=>error instanceof OfficialFailure&&error.kind==='schema'&&!error.message.includes('secret'));assert.equal(calls,1);
  await assert.rejects(readOfficial(fetcher(async()=>new Response(JSON.stringify({data:{}}))),'product/list'),/响应状态/);
});

test('login and permanent HTTP failures do not retry; transient HTTP failures retry once',async()=>{
  let calls=0;await assert.rejects(readOfficial(fetcher(async()=>{calls++;return new Response('',{status:401});}),'product/list'),LoginRequired);assert.equal(calls,1);
  calls=0;await assert.rejects(readOfficial(fetcher(async()=>{calls++;return new Response('',{status:404});}),'product/list'),/404/);assert.equal(calls,1);
  calls=0;const response=await readOfficial(fetcher(async()=>{calls++;return calls===1?new Response('',{status:503}):new Response(JSON.stringify({code:0,data:{}}));}),'product/list');assert.equal(calls,2);assert.deepEqual(response,{code:0,data:{}});
});

test('read cancellation prevents the next page, leaves no partial snapshot and reports the active phase',async()=>{
  const controller=new AbortController(),phases:string[]=[];let productCalls=0;
  await assert.rejects(fetchSnapshot(async path=>{
    if(path==='common/getCurrentInfo')return{code:0,data:{card_code:card.number,balance:100,is_usable:1}};
    if(path==='product/list'){productCalls++;controller.abort(new DOMException('cancel','AbortError'));return{code:0,data:{data_list:[{product_code:'p',inventory_id:'i',product_title:'商品'}],total_count:2,has_next:true}};}
    throw new Error('orders must not be read');
  },card,{signal:controller.signal,progress:phase=>{phases.push(phase);controller.signal.throwIfAborted();}}),error=>error instanceof Error&&error.name==='AbortError');
  assert.equal(productCalls,1);assert.equal(phases.at(-1),'products');
  const aborted=new AbortController();aborted.abort(new DOMException('cancel','AbortError'));let calls=0;
  await assert.rejects(readOfficial(fetcher(async()=>{calls++;return new Response('{}');}),'product/list',{},'GET',aborted.signal));assert.equal(calls,0);
});

test('IPC schema rejects forged patches, invalid queries and unsupported operations before business code',()=>{
  assert.throws(()=>validateIPC('unknown',[]),/数量/);
  assert.throws(()=>validateIPC('update-card',['fixture',{number:'987654321012'}]),/字段/);
  assert.throws(()=>validateIPC('settings',[{autoLogin:true,__unsafe:true}]),/字段/);
  assert.throws(()=>validateIPC('query-products',[{...DEFAULT_PRODUCT_QUERY,page:-1}]),/分页/);
  assert.throws(()=>validateIPC('add-cart',['p','c',Infinity]),/数量/);
  assert.throws(()=>validateIPC('open-card',['c','delete']),/类型/);
  validateIPC('query-products',[DEFAULT_PRODUCT_QUERY]);validateIPC('cancel-sync',[undefined]);validateIPC('update-card',['fixture',{tags:['福利']}]);
});

test('reminders and budget keep unknown balances and single-selection limits distinct',()=>{
  const now=Date.parse('2026-10-08T00:00:00+08:00');
  const reminders=expiryReminders([{...card,expiresAt:'2026-10-10'},{...card,id:'archived',archived:true,expiresAt:'2026-10-09'},{...card,id:'spent',balance:0,expiresAt:'2026-10-09'}],7,now);
  assert.equal(reminders.length,1);assert.equal(reminders[0].days,3);
  const product:Product={id:'p',name:'礼物',brand:'',category:'',specification:'',image:'',favorite:false,mergeKey:'',offers:[{cardId:card.id,sourceId:'source',price:30,priceUnit:'元',stock:null,syncedAt:'',variant:'',url:''}]};
  const items=[{id:'i',cardId:card.id,productId:'p',sourceId:'source',quantity:2}];
  assert.equal(budgetSummary(card,items,[product]).remaining,40);assert.equal(budgetSummary({...card,balance:null},items,[product]).remaining,null);
  assert.equal(budgetSummary({...card,balanceUnit:'单次任选额度'},items,[product]).remaining,null);
  assert.equal(budgetSummary({...card,balance:10},items,[product]).exceeds,true);
});

test('budget flags an exceeded known subtotal even when the complete total is unknown',()=>{
  const known:Product={id:'known',name:'已知商品',brand:'',category:'',specification:'',image:'',favorite:false,mergeKey:'',offers:[{cardId:card.id,sourceId:'known-source',price:30,priceUnit:'人民币',stock:10,syncedAt:'',variant:'',url:''}]};
  const unknown:Product={...known,id:'unknown',offers:[{...known.offers[0],sourceId:'unknown-source',price:null}]};
  const mixed:Product={...known,id:'mixed',offers:[{...known.offers[0],sourceId:'mixed-source',price:1,priceUnit:'次'}]};
  const noUnit:Product={...known,id:'no-unit',offers:[{...known.offers[0],sourceId:'no-unit-source',price:1,priceUnit:''}]};
  const items=[{id:'known-item',cardId:card.id,productId:known.id,sourceId:'known-source',quantity:4},{id:'unknown-item',cardId:card.id,productId:unknown.id,sourceId:'unknown-source',quantity:1}];
  for(const extra of [unknown,mixed,noUnit]){
    const result=budgetSummary(card,[items[0],{...items[1],productId:extra.id,sourceId:extra.offers[0].sourceId}],[known,extra]);
    assert.equal(result.total,null);assert.equal(result.remaining,null);assert.equal(result.exceeds,true);
  }
  assert.equal(budgetSummary({...card,balance:null},items,[known,unknown]).exceeds,false);
  assert.equal(budgetSummary({...card,balanceUnit:'单次任选额度'},items,[known,unknown]).exceeds,false);
  assert.equal(budgetSummary(card,[{...items[0],quantity:3},items[1]],[known,unknown]).exceeds,false);
});

test('CSV export masks card numbers and neutralizes spreadsheet formulas',()=>{
  const order:Order={id:'o',cardId:card.id,sourceId:' =HYPERLINK("bad")',name:'@SUM(1)',status:'已完成',amount:null,createdAt:'',tracking:'13800138000',url:''};
  const csv=exportOrderCSV([order],[card]);assert.ok(csv.startsWith('\uFEFF'));assert.ok(!csv.includes(card.number));assert.ok(!csv.includes('13800138000'));assert.ok(csv.includes("'@SUM(1)"));assert.ok(csv.includes("' =HYPERLINK"));
});

test('virtual windows render only visible rows and preserve the last partial row',()=>{
  const first=virtualWindow(10000,4,0,650,335);assert.equal(first.start,0);assert.ok(first.end<=4);assert.equal(first.totalHeight,2500*335);
  const last=virtualWindow(101,4,25*335,650,335);assert.equal(last.end,26);assert.ok(last.start<=25);
});

test('release manifest validation gates the download and backs up before opening a verified URL',async()=>{
  const events:string[]=[];
  const database={enqueueWrite:async(work:()=>unknown)=>work(),backup:()=>{events.push('backup');return'backup';}} as unknown as SqliteRepository;
  const manifest={format:'guanaitong-release',schemaVersion:1,version:'0.7.0',publishedAt:'2026-10-08T00:00:00.000Z',notes:'发布说明',downloads:{'win32-x64':{url:'https://example.com/app.exe',sha256:'a'.repeat(64)}}};
  const service=new ReleaseService('0.6.0','win32','x64',fetcher(async()=>new Response(JSON.stringify(manifest))),database,async()=>{events.push('open');});
  await assert.rejects(service.open(),/先检查/);await assert.rejects(service.check('file:///secret'),/HTTPS/);
  const info=await service.check('https://example.com/release.json');assert.equal(info.available,true);assert.equal(info.notes,'发布说明');await service.open();assert.deepEqual(events,['backup','open']);
  assert.equal(compareVersions('0.10.0','0.9.9'),1);assert.throws(()=>compareVersions('0.7.0;bad','0.6.0'));
});

test('malformed, oversized and downgraded releases cannot open an installer',async()=>{
  const database={enqueueWrite:async(work:()=>unknown)=>work(),backup:()=>{throw new Error('must not backup');}} as unknown as SqliteRepository;
  const service=new ReleaseService('0.6.0','win32','x64',fetcher(async()=>new Response(' '.repeat(300000))),database,async()=>{throw new Error('must not open');});
  await assert.rejects(service.check('https://example.com/release.json'),/过大/);await assert.rejects(service.open(),/先检查/);
  const older=new ReleaseService('0.6.0','win32','x64',fetcher(async()=>new Response(JSON.stringify({format:'guanaitong-release',schemaVersion:1,version:'0.5.0',publishedAt:'2026-10-08',notes:'older',downloads:{'win32-x64':{url:'https://example.com/old.exe',sha256:'a'.repeat(64)}}}))),database,async()=>{});
  assert.equal((await older.check('https://example.com/release.json')).available,false);await assert.rejects(older.open(),/先检查/);
});

test('signed release preparation fails before building when certificate credentials are absent',()=>{
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('CSC_')||key.startsWith('WIN_CSC_')||key==='REQUIRE_SIGNED')delete env[key];
  for(const platform of ['win','mac'])assert.throws(()=>execFileSync(process.execPath,['scripts/build-release.mjs',platform,'--signed'],{env,stdio:'pipe'}),error=>error instanceof Error&&'stderr' in error&&String(error.stderr).includes('requires'));
});
