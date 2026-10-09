import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach,test } from 'node:test';
import { ReleaseService } from '../electron/release-service';
import { DATABASE_VERSION } from '../electron/database-migrations';
import { DEFAULT_UPDATE_FEED,RELEASE_REPOSITORY } from '../src/shared/release-config';
import type { SqliteRepository } from '../electron/sqlite-repository';
import type { PreparedUpdate,UpdateProgress } from '../src/shared/operations';

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0)){const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.split(sep).at(-1)!.startsWith('gat-updates-'));rmSync(path,{recursive:true,force:true});}});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const bytes=Buffer.from('synthetic update package; never executable');
const manifestURL=`https://github.com/${RELEASE_REPOSITORY}/releases/download/v0.6.2/release.json`;
const assetURL=`https://github.com/${RELEASE_REPOSITORY}/releases/download/v0.6.2/guanaitong-hub-0.6.2-x64-setup.exe`;
const manifest=(patch:object={})=>({format:'guanaitong-release',schemaVersion:1,version:'0.6.2',publishedAt:'2026-10-08T00:00:00.000Z',notes:'合成更新说明',databaseVersion:DATABASE_VERSION,downloads:{'win32-x64':{url:assetURL,sha256:hash(bytes),size:bytes.length}},...patch});
const release=(patch:object={})=>({tag_name:'v0.6.2',draft:false,prerelease:false,published_at:'2026-10-08T00:00:00.000Z',assets:[{name:'release.json',state:'uploaded',browser_download_url:manifestURL},{name:'guanaitong-hub-0.6.2-x64-setup.exe',state:'uploaded',browser_download_url:assetURL,size:bytes.length,digest:'sha256:'+hash(bytes)}],...patch});
function fixture(fetcher:typeof fetch){
  const directory=mkdtempSync(join(tmpdir(),'gat-updates-'));directories.push(directory);const events:string[]=[],progress:UpdateProgress[]=[];
  const database={enqueueWrite:async(work:()=>unknown)=>work(),backup:(reason:string)=>{events.push(reason);return join(directory,reason+'.sqlite');}} as unknown as SqliteRepository;
  const service=new ReleaseService('0.6.1','win32','x64',fetcher,database,async()=>{events.push('browser');},{directory,openPath:async()=>{events.push('installer');return'';},progress:value=>progress.push(value)});
  return{service,directory,events,progress,database};
}
const fetcher=(work:(url:string,init?:RequestInit)=>Promise<Response>)=>((url:unknown,init?:RequestInit)=>work(String(url),init)) as typeof fetch;
const complete=()=>fetcher(async url=>url===DEFAULT_UPDATE_FEED?Response.json(release()):url===manifestURL?Response.json(manifest()):new Response(bytes));
const latestManifestURL=`https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/release.json`;
const checksumURL=manifestURL.replace('release.json','SHA256SUMS.txt');
const packageName=assetURL.split('/').at(-1)!;
const checksumText=hash(bytes)+'  '+packageName+'\n';
function fallbackFetcher(api:()=>Response|never, patch:{manifest?:object;checksums?:string;latestLocation?:string;checksumStatus?:number}={}, requests:string[]=[]) {
  return fetcher(async(url,init)=>{
    requests.push(url);assert.equal(init?.credentials,'omit');assert.equal((init?.headers as Record<string,string>).Authorization,undefined);
    if(url===DEFAULT_UPDATE_FEED)return api();
    if(url===latestManifestURL)return new Response('',{status:302,headers:{Location:patch.latestLocation??manifestURL}});
    if(url===manifestURL)return new Response('',{status:302,headers:{Location:'https://release-assets.githubusercontent.com/synthetic-manifest'}});
    if(url==='https://release-assets.githubusercontent.com/synthetic-manifest')return Response.json(manifest(patch.manifest));
    if(url===checksumURL)return new Response(patch.checksums??checksumText,{status:patch.checksumStatus??200});
    if(url===assetURL)return new Response(bytes);
    throw new Error('Unexpected synthetic request: '+url);
  });
}

test('default source resolves GitHub release, manifest, platform and API digest without cookies',async()=>{
  const requests:{url:string;init?:RequestInit}[]=[];
  const f=fixture(fetcher(async(url,init)=>{requests.push({url,init});return url===DEFAULT_UPDATE_FEED?Response.json(release()):Response.json(manifest());}));
  const info=await f.service.check('');assert.equal(info.source,'github');assert.equal(info.available,true);assert.equal(info.sha256,hash(bytes));assert.equal(info.size,bytes.length);
  assert.deepEqual(requests.map(item=>item.url),[DEFAULT_UPDATE_FEED,manifestURL]);assert.ok(requests.every(item=>item.init?.credentials==='omit'&&item.init.redirect==='manual'));assert.equal((requests[0].init!.headers as Record<string,string>).Authorization,undefined);
});

test('GitHub API rate limits and temporary outages fall back to the official latest stable assets',async()=>{
  for(const status of [403,429,500,502,503,504]){
    const requests:string[]=[];
    const f=fixture(fallbackFetcher(()=>new Response('API rate limit exceeded',{status,headers:{'x-ratelimit-remaining':'0'}}),{},requests));
    const info=await f.service.check();
    assert.equal(info.source,'github');assert.equal(info.available,true);assert.equal(info.version,'0.6.2');assert.equal(info.releaseUrl,`https://github.com/${RELEASE_REPOSITORY}/releases/tag/v0.6.2`);
    assert.deepEqual(requests,[DEFAULT_UPDATE_FEED,latestManifestURL,manifestURL,'https://release-assets.githubusercontent.com/synthetic-manifest',checksumURL]);
    assert.deepEqual(f.events,[]);
    const prepared=await f.service.prepare();assert.deepEqual(readFileSync(prepared.filePath),bytes);assert.deepEqual(f.events,['before-program-update']);
  }
});

test('GitHub API connection and timeout errors can use the published asset channel',async()=>{
  for(const error of [new TypeError('fetch failed'),new DOMException('timeout','TimeoutError')]){
    const f=fixture(fallbackFetcher(()=>{throw error;}));assert.equal((await f.service.check()).available,true);assert.deepEqual(f.events,[]);
  }
});

test('fallback pins the repository, stable tag, release manifest version and package locations',async()=>{
  const cases=[
    {latestLocation:'https://example.com/release.json'},
    {latestLocation:manifestURL.replace(RELEASE_REPOSITORY,'other/project')},
    {latestLocation:manifestURL.replace('v0.6.2','v0.6.2-beta')},
    {latestLocation:manifestURL+'?draft=1'},
    {latestLocation:'https://release-assets.githubusercontent.com/no-stable-tag'},
    {manifest:{version:'0.7.0'}},
    {manifest:{downloads:{'win32-x64':{url:assetURL.replace('v0.6.2','v0.7.0'),sha256:hash(bytes),size:bytes.length}}}},
    {manifest:{downloads:{'win32-x64':{url:assetURL.replace(packageName,'nested/'+packageName),sha256:hash(bytes),size:bytes.length}}}},
  ];
  for(const patch of cases){
    const f=fixture(fallbackFetcher(()=>new Response('',{status:403}),patch));
    await assert.rejects(f.service.check(),/官方发布通道读取失败/);await assert.rejects(f.service.prepare(),/先检查/);assert.deepEqual(f.events,[]);
  }
});

test('fallback checksum mismatches, absent package sizes and oversized metadata cannot prepare an update',async()=>{
  const cases=[
    {checksums:'0'.repeat(64)+'  '+packageName+'\n'},
    {checksums:checksumText+checksumText},
    {checksums:''},
    {checksums:'0'.repeat(300000)},
    {checksumStatus:404},
    {manifest:{downloads:{'win32-x64':{url:assetURL,sha256:hash(bytes)}}}},
    {manifest:{downloads:{'win32-x64':{url:assetURL,sha256:'bad',size:bytes.length}}}},
    {manifest:{notes:'x'.repeat(300000)}},
  ];
  for(const patch of cases){const f=fixture(fallbackFetcher(()=>new Response('',{status:403}),patch));await assert.rejects(f.service.check(),/官方发布通道读取失败/);assert.deepEqual(f.events,[]);assert.deepEqual(readdirSync(f.directory),[]);}
});

test('permanent API errors, invalid release metadata and custom feed errors do not use fallback',async()=>{
  for(const status of [401,404,422]){
    const requests:string[]=[];const f=fixture(fallbackFetcher(()=>new Response('',{status}),{},requests));
    if(status===404)assert.equal((await f.service.check()).status,'unpublished');else await assert.rejects(f.service.check(),new RegExp(String(status)));
    assert.deepEqual(requests,[DEFAULT_UPDATE_FEED]);
  }
  for(const patch of [{draft:true},{prerelease:true}]){
    const requests:string[]=[];const f=fixture(fallbackFetcher(()=>Response.json(release(patch)),{},requests));
    await assert.rejects(f.service.check(),/发布信息无效/);assert.deepEqual(requests,[DEFAULT_UPDATE_FEED]);
  }
  const requests:string[]=[];const custom=fixture(fetcher(async url=>{requests.push(url);return new Response('',{status:403});}));
  await assert.rejects(custom.service.check('https://example.com/release.json'),/HTTP 403/);assert.deepEqual(requests,['https://example.com/release.json']);
});

test('a stale fallback response cannot replace a newer checked custom feed',async()=>{
  let resolveAPI!:(response:Response)=>void;const pendingAPI=new Promise<Response>(resolve=>{resolveAPI=resolve;});
  const fallback=fallbackFetcher(()=>new Response('',{status:403}));
  const f=fixture(fetcher(async(url,init)=>url===DEFAULT_UPDATE_FEED?pendingAPI:url==='https://example.com/new.json'?Response.json(manifest()):fallback(url,init)));
  const first=f.service.check();await f.service.check('https://example.com/new.json');resolveAPI(new Response('',{status:403}));
  await assert.rejects(first,/来源已变化/);assert.equal((await f.service.prepare()).version,'0.6.2');
});

test('unpublished, draft, prerelease and missing platform states cannot prepare an update',async()=>{
  const none=fixture(fetcher(async()=>new Response('',{status:404})));assert.equal((await none.service.check()).status,'unpublished');await assert.rejects(none.service.prepare(),/先检查/);
  for(const patch of [{draft:true},{prerelease:true}]){const f=fixture(fetcher(async()=>Response.json(release(patch))));await assert.rejects(f.service.check(),/发布信息无效/);}
  const missing=fixture(fetcher(async()=>Response.json(manifest({downloads:{}}))));assert.equal((await missing.service.check('https://example.com/manifest.json')).status,'unsupported');await assert.rejects(missing.service.prepare(),/先检查/);
});

test('GitHub tag, manifest asset URL, digest and size disagreements reject a release',async()=>{
  const cases=[manifest({version:'0.7.0'}),manifest({downloads:{'win32-x64':{url:'https://example.com/bad.exe',sha256:hash(bytes),size:bytes.length}}}),manifest({downloads:{'win32-x64':{url:assetURL,sha256:'0'.repeat(64),size:bytes.length}}}),manifest({downloads:{'win32-x64':{url:assetURL,sha256:hash(bytes),size:bytes.length+1}}})];
  for(const value of cases){const f=fixture(fetcher(async url=>url===DEFAULT_UPDATE_FEED?Response.json(release()):Response.json(value)));await assert.rejects(f.service.check(),/不一致/);assert.deepEqual(f.events,[]);}
  const f=fixture(fetcher(async()=>Response.json(release({assets:[]}))));await assert.rejects(f.service.check(),/缺少统一/);
});

test('verified update downloads to a private cache and backs up before install handover',async()=>{
  const f=fixture(complete());await f.service.check();const prepared=await f.service.prepare();
  assert.equal(prepared.sha256,hash(bytes));assert.deepEqual(readFileSync(prepared.filePath),bytes);assert.deepEqual(f.events,['before-program-update']);assert.equal(f.progress.at(-1)!.phase,'ready');
  await f.service.install();assert.deepEqual(f.events,['before-program-update','before-install-update','installer']);assert.equal(f.service.busy,false);
});

test('checksum mismatch, truncated download and backup failure remove update cache and never launch',async()=>{
  for(const content of [Buffer.from('tampered'),bytes.subarray(0,3)]){
    const f=fixture(fetcher(async url=>url===DEFAULT_UPDATE_FEED?Response.json(release()):url===manifestURL?Response.json(manifest()):new Response(content)));await f.service.check();await assert.rejects(f.service.prepare(),/校验|大小/);assert.deepEqual(readdirSync(f.directory),[]);assert.deepEqual(f.events,[]);await assert.rejects(f.service.install(),/先下载/);
  }
  const f=fixture(complete());f.database.backup=()=>{throw new Error('backup failed');};await f.service.check();await assert.rejects(f.service.prepare(),/backup failed/);assert.deepEqual(readdirSync(f.directory),[]);
});

test('cancellation cleans an unfinished download and a later retry can complete',async()=>{
  let released!:()=>void;const gate=new Promise<void>(resolve=>{released=resolve;});let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});let first=true;
  const f=fixture(fetcher(async url=>{if(url===DEFAULT_UPDATE_FEED)return Response.json(release());if(url===manifestURL)return Response.json(manifest());if(first){first=false;return new Response(new ReadableStream({async pull(controller){started();await gate;controller.enqueue(bytes);controller.close();}}));}return new Response(bytes);}));
  await f.service.check();const pending=f.service.prepare();await entered;f.service.cancel();released();await assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');assert.deepEqual(readdirSync(f.directory),[]);assert.deepEqual(f.events,[]);assert.equal(f.service.busy,false);
  const next=await f.service.prepare();assert.equal(next.size,bytes.length);
});

test('tampering after verification prevents opening even when the file size is unchanged',async()=>{
  const f=fixture(complete());await f.service.check();const prepared=await f.service.prepare();writeFileSync(prepared.filePath,Buffer.alloc(prepared.size,0));await assert.rejects(f.service.install(),/文件已变化/);assert.deepEqual(f.events,['before-program-update']);
});

test('redirects remain HTTPS and GitHub downloads reject unrelated hosts',async()=>{
  const f=fixture(fetcher(async url=>url===DEFAULT_UPDATE_FEED?Response.json(release()):new Response('',{status:302,headers:{Location:'http://example.com/plain'}})));await assert.rejects(f.service.check(),/HTTPS/);
  const other=fixture(fetcher(async url=>url===DEFAULT_UPDATE_FEED?Response.json(release()):new Response('',{status:302,headers:{Location:'https://example.com/foreign'}})));await assert.rejects(other.service.check(),/未知来源/);
  let redirects=0;const loop=fixture(fetcher(async url=>url===DEFAULT_UPDATE_FEED?Response.json(release()):new Response('',{status:302,headers:{Location:`https://release-assets.githubusercontent.com/path/${++redirects}`}})));await assert.rejects(loop.service.check(),/重定向/);assert.equal(redirects,6);
});

test('current, downgraded and incompatible data schema packages cannot be installed',async()=>{
  for(const version of ['0.6.1','0.5.0']){const f=fixture(fetcher(async()=>Response.json(manifest({version}))));assert.equal((await f.service.check('https://example.com/manifest.json')).available,false);await assert.rejects(f.service.prepare(),/先检查/);}
  const schema=fixture(fetcher(async()=>Response.json(manifest({databaseVersion:2}))));await assert.rejects(schema.service.check('https://example.com/manifest.json'),/数据结构过旧/);
});

test('overlapping checks cannot replace a newer checked source with a stale reply',async()=>{
  let resolveFirst!:(value:Response)=>void;const first=new Promise<Response>(resolve=>{resolveFirst=resolve;});
  const f=fixture(fetcher(async url=>url.includes('first')?first:url===assetURL?new Response(bytes):Response.json(manifest())));
  const pending=f.service.check('https://example.com/first.json');await f.service.check('https://example.com/second.json');resolveFirst(Response.json(manifest({version:'9.0.0'})));await assert.rejects(pending,/来源已变化/);assert.equal((await f.service.prepare()).version,'0.6.2');
});
