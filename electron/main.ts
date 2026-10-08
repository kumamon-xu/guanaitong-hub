import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell, type Session } from 'electron';
import { readFileSync, mkdirSync, chmodSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AppState, SyncResult } from '../src/shared/types';
import { HubStore } from './store';
import { API_BASE, LOGIN_URL, ORDERS_URL, LoginRequired, fetchSnapshot, normalizeCard, officialURL, unwrap } from './adapter';
import { fetchProductCategories, type CategoryRequestMethod } from './categories';
import { SessionVault, officialCookieDetails, normalizeOfficialCookies } from './session-vault';
import { AddressVault } from './addresses';
import { fetchRegions, normalizeOfficialAddresses, publishOfficialAddress } from './official-addresses';
import { automateLogin } from './auto-login';
import { LoginCoordinator } from './login-coordinator';
import { finishHiddenLogin } from './login-window';
import { openStorage } from './storage-migration';
import type { SqliteRepository } from './sqlite-repository';
import { BackupService, type PreparedRestore } from './backup-service';
import { diagnosticSummary, redactText } from './redaction';
import { atomicWrite } from './legacy-storage';
import { readOfficial, classifyFailure, throwIfCancelled } from './official-client';
import { SyncManager, type SyncContext } from './sync-manager';
import { validateIPC } from './ipc-validation';
import { ReleaseService } from './release-service';
import { exportOrderCSV } from './order-export';
import type { SyncTask, OrderQuery } from '../src/shared/operations';

// Keep the same vault and OS keychain identity in development and packaged builds.
app.setName('guanaitong-hub');
app.setPath('userData',join(app.getPath('appData'),'guanaitong-hub'));

let mainWindow: BrowserWindow | null = null;
let store: HubStore;
let sessionVault:SessionVault;
let addressVault:AddressVault;
let database:SqliteRepository;
let backupService:BackupService;
let syncManager:SyncManager;
let releaseService:ReleaseService;
let revision=0;
let restoring = false;
let remoteOperations = 0;
let sessionEpoch = 0;
const cardWindows = new Map<string, BrowserWindow>();
const automaticWindows = new Set<BrowserWindow>();
const sessions = new Map<string, Session>();
const sessionReady = new Map<string, Promise<Session>>();
const runningSync = new Map<string, Promise<SyncResult>>();
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDestinations = new Map<string,string>();
const failedRestores = new Set<string>();
const publishingAddresses = new Set<string>();
const regionReads = new Map<string,ReturnType<typeof fetchRegions>>();
const loginCoordinator=new LoginCoordinator();
let dataDirectory = '';
let quitting = false;
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
function notify(_state?:AppState) { if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hub:invalidated',++revision); }
function getCard(id: string) { return store.getCard(id); }
function notifyTasks(tasks:SyncTask[]){if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('hub:sync-tasks',tasks);}
function saveSession(id: string) {
  const ses=sessions.get(id); if(restoring||!ses||failedRestores.has(id))return Promise.resolve();
  return sessionVault.save(id,()=>ses.cookies.get({domain:'guanaitong.com'}));
}
async function cardSession(id: string): Promise<Session> {
  getCard(id);
  const ready=sessionReady.get(id);if(ready)return ready;
  const existing=sessions.get(id); if(existing)return existing;
  const loading=(async()=>{
  // Use an in-memory Chromium session. Cookies are persisted only in an OS-encrypted file.
  const ses=session.fromPartition(`card-${sessionEpoch}-${id}`); sessions.set(id,ses);
  ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  try{for(const cookie of sessionVault.load(id))await ses.cookies.set(officialCookieDetails(cookie));}
  catch{failedRestores.add(id);await database.enqueueWrite(()=>store.addActivity('保存的官网登录会话无法恢复，需要重新登录；原会话数据已保留。','warning',id));}
  ses.cookies.on('changed',()=>{
    if(restoring||sessions.get(id)!==ses)return;
    if(sessionTimers.has(id))return;
    sessionTimers.set(id,setTimeout(()=>{sessionTimers.delete(id);saveSession(id).catch(()=>{});},300));
  });
  return ses;
  })();
  sessionReady.set(id,loading);
  try{return await loading;}catch(error){sessions.delete(id);sessionReady.delete(id);throw error;}
}
async function request(id:string,path:string,params:Record<string,unknown>={},method:CategoryRequestMethod='GET',signal?:AbortSignal) {
  throwIfCancelled(signal);const ses=await cardSession(id);
  return readOfficial(ses.fetch.bind(ses) as typeof fetch,path,params,method,signal);
}
async function syncCard(id:string):Promise<SyncResult>{
  getCard(id);return syncManager.run(id,context=>performSync(id,context));
}
async function performSync(id: string,context:SyncContext): Promise<SyncResult> {
  const pending=runningSync.get(id); if(pending)return pending;
  const work=(async()=>{
    try {
      const card=getCard(id);
      let snapshot;
      try{snapshot=await fetchSnapshot((path,params)=>request(id,path,params,'GET',context.signal),card,context);}
      catch(error){
        if(!(error instanceof LoginRequired)||!store.getViewState().settings.autoLogin)throw error;
        if(!await automaticLogin(id,context.signal))throw new LoginRequired(loginCoordinator.failureReason(id)??error.message);
        snapshot=await fetchSnapshot((path,params)=>request(id,path,params,'GET',context.signal),card,context);
      }
      const warnings:string[]=[];
      try{
        context.progress('categories');throwIfCancelled(context.signal);const home=await shopURL(id,context.signal);
        const categories=await fetchProductCategories((path,params,method)=>request(id,path,params,method,context.signal),home,id,{loadHomeHTML:async url=>{
          if(!officialURL(url))throw new Error('分类首页不是官网地址');
          const response=await(await cardSession(id)).fetch(url,{credentials:'include',redirect:'error',signal:AbortSignal.any([context.signal,AbortSignal.timeout(20000)])});
          if(!response.ok)throw new Error('分类首页读取失败');return response.text();
        }});
        const previousCategories=new Map(store.getState().products.flatMap(product=>product.offers.filter(offer=>offer.cardId===id).map(offer=>[offer.sourceId,offer.categories??[]] as const)));
        for(const product of snapshot.products)for(const offer of product.offers){
          const names=categories.bySourceId[offer.sourceId];
          if(names){const retained=categories.complete?names:[...new Set([...names,...(previousCategories.get(offer.sourceId)??[])])];offer.categories=retained;product.categories=retained;product.category=retained[0]??'未分类';}
        }
        warnings.push(...categories.warnings);
        if(categories.complete&&snapshot.products.some(product=>product.offers.some(offer=>!categories.sourceIds.includes(offer.sourceId))))warnings.push('部分商品未出现在官网分类目录，已保留完整商品总库并标记未分类。');
      }catch(error){throwIfCancelled(context.signal);warnings.push(error instanceof Error?error.message:'分类暂时无法更新');}
      snapshot.card={...snapshot.card,...normalizeCard(unwrap(await request(id,'common/getCurrentInfo',{},'GET',context.signal)),card)};
      failedRestores.delete(id);
      context.progress('commit');
      await database.enqueueWrite(()=>{throwIfCancelled(context.signal);return store.applySnapshot(id,{...snapshot,activity:{message:`同步完成：${snapshot.products.length} 个商品，${snapshot.orders.length} 笔订单。`,type:'success'}});});
      try{await saveSession(id);}catch{warnings.push('本次登录会话保存失败，当前数据已收集；重启后可能需要重新登录。');}
      if(warnings.length)await database.enqueueWrite(()=>store.addActivity(('商品与余额已同步，分类提示：'+warnings.join('；')).slice(0,3900),'warning',id));
      notify();
      return{cardId:id,ok:true,message:warnings.length?'商品、余额和订单已同步，请查看同步提示。':'商品、分类、余额和订单已同步。'};
    }catch(error){
      if(context.signal.aborted)return{cardId:id,ok:false,cancelled:true,message:'已取消同步，上次完整数据已保留'};
      const message=error instanceof Error?error.message:'同步失败';
      await database.enqueueWrite(()=>store.applySnapshot(id,{card:{...(error instanceof LoginRequired?{status:'error' as const}:{}),error:redactText(message,[getCard(id).number,store.getPassword(id)])},activity:{message,type:'warning'}}));
      notify();
      throw error;
    }finally{runningSync.delete(id);}
  })(); runningSync.set(id,work); return work;
}
async function isLoggedIn(id: string,signal?:AbortSignal) {
  try {
    const data=unwrap(await request(id,'common/getCurrentInfo',{},'GET',signal));
    if(data.card_code==null)return false;
    if(String(data.card_code)!==getCard(id).number)throw new Error('官网会话属于其他卡号，已停止操作。');
    failedRestores.delete(id);loginCoordinator.authenticated(id);return true;
  } catch(error) {if(error instanceof LoginRequired)return false;throw error;}
}
async function automaticLogin(id:string,signal?:AbortSignal):Promise<boolean>{
  const allowed=()=>{
    const state=store.getState(),card=state.cards.find(card=>card.id===id);
    return !signal?.aborted&&!quitting&&state.settings.autoLogin&&!!card&&!card.archived&&!['expired','exhausted'].includes(card.status);
  };
  if(!allowed())return false;
  return loginCoordinator.run(id,async()=>{
    if(!allowed())return false;
    if(await isLoggedIn(id,signal))return true;
    const win=await createRemoteWindow(id,true);
    automaticWindows.add(win);
    const cancel=()=>{if(automaticWindows.has(win)&&!win.isDestroyed())win.destroy();};
    signal?.addEventListener('abort',cancel,{once:true});
    await database.enqueueWrite(()=>store.addActivity('官网登录已失效，正在后台自动重新登录。','info',id));notify();
    try{
      const result=await finishHiddenLogin({window:win,enabled:allowed,
        handOff:window=>{automaticWindows.delete(window);cardWindows.set(id,window);},
        recover:async()=>{
          await win.loadURL(LOGIN_URL);
          const result=await automateLogin({window:win,session:await cardSession(id),number:getCard(id).number,enabled:allowed,loggedIn:()=>isLoggedIn(id,signal),
            progress:message=>{void database.enqueueWrite(()=>{store.addActivity(message,'info',id);notify();}).catch(()=>{});},
            ...(process.env.HUB_LOGIN_DIAGNOSTICS?{diagnostic:(metadata:Record<string,unknown>)=>{
              const folder=resolve(process.cwd(),'.private','login-diagnostics');mkdirSync(folder,{recursive:true,mode:0o700});
              writeFileSync(join(folder,'latest.json'),JSON.stringify({...metadata,visible:win.isVisible(),focused:win.isFocused()},null,2),{mode:0o600});
            }}:{})});
          if(result.ok){failedRestores.delete(id);await saveSession(id);}
          return result;
        }});
      await database.enqueueWrite(()=>store.applySnapshot(id,{...(result.ok?{}:{card:{status:'error',error:redactText(result.reason,[getCard(id).number,store.getPassword(id)])}}),activity:{message:result.ok?'后台自动登录成功，官网卡号已核对。':result.reason,type:result.ok?'success':'warning'}}));
      notify();return result;
    }finally{signal?.removeEventListener('abort',cancel);automaticWindows.delete(win);}
  });
}
async function ensureLoggedIn(id:string):Promise<boolean>{
  return await isLoggedIn(id)||await automaticLogin(id);
}
async function shopURL(id: string,signal?:AbortSignal) {
  const data=unwrap(await request(id,'card/getProductHomeUrl',{card_code:getCard(id).number},'GET',signal));
  return typeof data.pc_product_home_url==='string'&&officialURL(data.pc_product_home_url)?data.pc_product_home_url:'https://a.guanaitong.com/festival-exchange-pc/product-search';
}
function protectRemote(window: BrowserWindow,id: string) {
  const cardTitle=()=>`${getCard(id).label} · 卡号 ${getCard(id).number} · 官网兑换`;
  window.setTitle(cardTitle());
  window.webContents.on('page-title-updated',event=>{event.preventDefault();window.setTitle(cardTitle());});
  window.webContents.on('will-navigate',(event,url)=>{if(!officialURL(url))event.preventDefault();});
  window.webContents.on('will-redirect',(event,url)=>{if(!officialURL(url))event.preventDefault();});
  window.webContents.setWindowOpenHandler(({url})=>{
    if(!automaticWindows.has(window)&&officialURL(url))openRemote(id,url).catch(()=>{});
    return{action:'deny'};
  });
  const pageReady=async()=>{
    try{
    const url=window.webContents.getURL();
    const currentURL=new URL(url);
    if(currentURL.origin==='https://a.guanaitong.com'&&currentURL.pathname==='/festival-exchange-pc/login') {
      const card=getCard(id);const password=store.getPassword(id);
      // Populate only the original official form, in either the hidden or manual window.
      await window.webContents.executeJavaScript(`(() => {
        const fill=()=>{
          const form=document.querySelector('form'); if(!form)return false;
          const code=form.querySelector('#basic_code') || form.querySelector('input');
          const password=form.querySelector('input[type="password"]'); if(!code||!password)return false;
          const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
          for(const [input,value] of [[code,${JSON.stringify(card.number)}],[password,${JSON.stringify(password)}]]) {setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
          return true;
        };
        if(!fill()){let count=0;const timer=setInterval(()=>{if(fill()||++count>50)clearInterval(timer);},200);}
      })()`).catch(()=>{});
    } else if(officialURL(url)) {
      // Automatic recovery owns its login window until the card identity is verified.
      if(!loginCoordinator.isRunning(id)&&await isLoggedIn(id)){
        await syncCard(id);
        const destination=pendingDestinations.get(id);
        if(destination){pendingDestinations.delete(id);if(window.webContents.getURL()!==destination)await window.loadURL(destination);}
      }
    }
    }catch(error){await database.enqueueWrite(()=>store.addActivity(error instanceof Error?error.message:'官网窗口读取失败','warning',id));notify();}
  };
  window.webContents.on('did-finish-load',()=>void pageReady());
  window.webContents.on('did-navigate-in-page',()=>void pageReady());
  window.on('closed',()=>{
    if(cardWindows.get(id)===window)cardWindows.delete(id);
    automaticWindows.delete(window);saveSession(id).catch(()=>{});
  });
}
async function createRemoteWindow(id:string,hidden=false):Promise<BrowserWindow>{
  const win=new BrowserWindow({width:1280,height:880,show:false,title:`${getCard(id).label} · 官方兑换窗口`,webPreferences:{session:await cardSession(id),backgroundThrottling:!hidden,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  protectRemote(win,id);return win;
}
async function openRemote(id: string,url: string) {
  if(!officialURL(url))throw new Error('商品链接不是关爱通官网地址');
  let win=cardWindows.get(id);
  if(!win||win.isDestroyed()) {
    win=await createRemoteWindow(id);
    cardWindows.set(id,win);
  }
  win.show();win.focus();if(win.webContents.getURL()!==url)await win.loadURL(url);
}
async function openCard(id: string,purpose='login') {
  getCard(id);
  const logged=await ensureLoggedIn(id);
  const url=!logged?LOGIN_URL:purpose==='orders'?ORDERS_URL:purpose==='addresses'?'https://a.guanaitong.com/festival-exchange-pc/address/list':await shopURL(id);
  if(!logged&&purpose==='addresses')pendingDestinations.set(id,'https://a.guanaitong.com/festival-exchange-pc/address/list');
  await openRemote(id,url);
  if(logged&&purpose==='login')await syncCard(id);
}
async function openProduct(productId:string,cardId:string,sourceId?:string) {
  getCard(cardId);
  const product=store.getState().products.find(p=>p.id===productId);
  const offers=product?.offers.filter(o=>o.cardId===cardId&&(!sourceId||o.sourceId===sourceId));
  if(!offers?.length)throw new Error('找不到该卡片的商品报价');
  if(offers.length>1)throw new Error('请选择具体商品报价后打开官网');
  const url=offers[0].url;
  if(!officialURL(url))throw new Error('商品地址不是官网链接');
  if(!await ensureLoggedIn(cardId)){pendingDestinations.set(cardId,url);await openRemote(cardId,LOGIN_URL);}else await openRemote(cardId,url);
}
async function checkout(id: string) {
  const quote=store.quoteCart(id);
  if(!quote.items.length)throw new Error('该卡没有兑换计划');
  if(!await ensureLoggedIn(id)) {await openRemote(id,LOGIN_URL);throw new LoginRequired(loginCoordinator.failureReason(id)??'请在官网窗口完成登录，再返回兑换计划。');}
  const state=store.getState();
  const lines=quote.items.map(item=>{
    const product=state.products.find(p=>p.id===item.productId)!;
    const offer=product.offers.find(o=>o.cardId===id&&o.sourceId===item.sourceId)!;
    return{name:product.name,quantity:item.quantity,url:offer.url};
  });
  await dialog.showMessageBox(mainWindow!,{type:'info',title:'前往官网确认兑换',message:`本卡计划共 ${lines.length} 个商品，${quote.total} ${quote.unit}。`,
    detail:lines.map(x=>`${x.name} ×${x.quantity}`).join('\n')+'\n\n'+quote.warnings.join('；')+'\n接下来打开第一个商品的官网详情。请在官网选择规格、数量和收货地址，再提交兑换；本地清单会保留，兑换后请同步检查。多商品请从商品目录逐项打开。',buttons:['打开官网商品','取消'],defaultId:0,cancelId:1}).then(async result=>{
      if(result.response===0){await openRemote(id,lines[0].url);await database.enqueueWrite(()=>store.addActivity('已打开官网兑换页面，请在官网确认规格、数量和最终兑换。','info',id));notify();}
    });
}
function registerIPC() {
  const handle=(name:string,handler:(...args:any[])=>any)=>ipcMain.handle(`hub:${name}`,(event,...args)=>{
    if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('无权访问本地卡片数据');
    if(restoring)throw new Error('正在恢复备份，请稍后再操作');
    validateIPC(name,args);
    return handler(...args);
  });
  const mutate=(fn:()=>AppState)=>database.enqueueWrite(()=>{fn();notify();return store.getViewState();});
  const remote=(fn:(...args:any[])=>Promise<any>)=>async(...args:any[])=>{remoteOperations++;try{return await fn(...args);}finally{remoteOperations--;}};
  handle('state',()=>store.getState());
  handle('view-state',()=>store.getViewState());
  handle('query-products',query=>database.queryProducts(query));
  handle('product',id=>store.getProduct(id));
  handle('query-orders',query=>database.queryOrders(query));
  handle('sync-tasks',()=>syncManager.list());
  handle('cancel-sync',id=>syncManager.cancel(id));
  handle('retry-sync',remote(()=>syncManager.all([...new Set([...new Map([...syncManager.list()].reverse().map(task=>[task.cardId,task])).values()].filter(task=>['failed','cancelled','interrupted'].includes(task.status)).map(task=>task.cardId))].filter(id=>!getCard(id).archived),(id,context)=>performSync(id,context))));
  handle('price-history',(id,sourceId)=>database.priceHistory(id,sourceId));
  handle('check-updates',()=>releaseService.check(store.getViewState().settings.updateFeed??''));
  handle('open-update',()=>releaseService.open());
  handle('export-orders',async(query:OrderQuery)=>{
    const rows=[];let page=1,total=0;
    do{const result=database.queryOrders({...query,page,pageSize:100});rows.push(...result.items);total=result.total;page++;}while(rows.length<total);
    const contents=exportOrderCSV(rows,store.getViewState().cards);
    const result=await dialog.showSaveDialog(mainWindow!,{title:'导出筛选订单（脱敏）',defaultPath:'关爱通订单.csv',filters:[{name:'订单 CSV',extensions:['csv']}]});
    if(result.canceled||!result.filePath)return false;atomicWrite(result.filePath,contents);return true;
  });
  handle('addresses',()=>addressVault.list());
  handle('save-address',(draft,id)=>database.enqueueWrite(()=>addressVault.save(draft,id)));
  handle('default-address',id=>database.enqueueWrite(()=>addressVault.setDefault(id)));
  handle('remove-address',id=>database.enqueueWrite(()=>addressVault.remove(id)));
  handle('export-addresses',async(passphrase:string)=>{
    const backup=addressVault.exportBackup(passphrase);
    const result=await dialog.showSaveDialog(mainWindow!,{title:'保存地址加密备份',defaultPath:'关爱通收货地址.gataddr',filters:[{name:'加密地址备份',extensions:['gataddr']}]});
    if(result.canceled||!result.filePath)return false;
    atomicWrite(result.filePath,backup);return true;
  });
  handle('import-addresses',async(passphrase:string)=>{
    const result=await dialog.showOpenDialog(mainWindow!,{title:'恢复地址加密备份',properties:['openFile'],filters:[{name:'加密地址备份',extensions:['gataddr']}]});
    if(result.canceled)return null;
    if(statSync(result.filePaths[0]).size>8*1024*1024)throw new Error('地址备份文件过大');
    const prepared=backupService.prepare(readFileSync(result.filePaths[0],'utf8'),passphrase);
    if(prepared.kind!=='addresses')throw new Error('请在设置与备份中恢复卡片或统一备份');
    if(!await confirmRestore(prepared))return null;
    await applyRestore(prepared);return addressVault.list();
  });
  handle('address-regions',async(parentId?:string)=>{
    if(parentId!==undefined&&(typeof parentId!=='string'||!/^\d{1,20}$/.test(parentId)))throw new Error('地区标识无效');
    const key=parentId??'root';let pending=regionReads.get(key);
    if(!pending){pending=fetchRegions(parentId);regionReads.set(key,pending);pending.catch(()=>regionReads.delete(key));}
    return pending;
  });
  handle('official-addresses',remote(async(id:string)=>{
    if(!await ensureLoggedIn(id))throw new LoginRequired(loginCoordinator.failureReason(id)??'该卡官网会话已失效，请打开官网完成登录后读取地址。');
    const rows:any[]=[];const seen=new Set<string>();let total:number|undefined;
    for(let page=1;page<=100;page++){
      const data=unwrap(await request(id,'address/list',{page,rows_per_page:50}));
      const current=normalizeOfficialAddresses(data);
      if(data.total_count!=null){const count=Number(data.total_count);if(!Number.isInteger(count)||count<0||(total!==undefined&&total!==count))throw new Error('官网地址数量变化，请重新读取。');total=count;}
      for(const address of current){if(seen.has(address.id))throw new Error('官网地址分页重复，已停止读取，请到官网核对。');seen.add(address.id);}
      rows.push(...current);
      if(data.has_next===false||(data.has_next==null&&(total!==undefined?rows.length>=total:current.length<50))){if(total!==undefined&&rows.length!==total)throw new Error('官网地址尚未完整读取，请到官网核对。');break;}
      if(!current.length||page===100)throw new Error('官网地址分页读取未完成，请到官网核对。');
    }
    if(!await isLoggedIn(id))throw new LoginRequired('地址读取期间会话已失效，未保存地址。');
    return rows;
  }));
  handle('publish-address',remote(async(id:string,localId:string,makeDefault:boolean)=>{
    const card=getCard(id);
    if(card.archived)throw new Error('请先恢复这张卡片后添加官网地址。');
    const address=addressVault.list().find(a=>a.id===localId);if(!address)throw new Error('本地地址不存在');
    if(typeof makeDefault!=='boolean')throw new Error('默认地址选项无效');
    if(publishingAddresses.has(id))throw new Error('该卡地址正在保存，请等待结果。');
    publishingAddresses.add(id);
    try{
      if(!await ensureLoggedIn(id))throw new LoginRequired(loginCoordinator.failureReason(id)??'请先在该卡官网窗口完成登录后添加地址。');
      const result=await publishOfficialAddress(async(path,params,method)=>{
        if(path!=='address/add')return request(id,path,params,method);
        if(method!=='POST')throw new Error('地址接口方法无效');
        // Explicit address submission is separate from read-only retries. Never retry this write.
        if(!await isLoggedIn(id))throw new LoginRequired();
        const response=await(await cardSession(id)).fetch(API_BASE+'address/add',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded',platform:'browser',channel:'common','Client-Type':'2',version:'1.0.0','Ecapp-Code':'card_exchange',Referer:LOGIN_URL,Origin:'https://a.guanaitong.com'},body:new URLSearchParams(Object.entries(params??{}).map(([key,value])=>[key,String(value)])).toString(),credentials:'include',redirect:'error',signal:AbortSignal.timeout(25000)});
        if(!response.ok)throw new Error('官网地址保存失败');return response.json();
      },address,makeDefault);
      if(!await isLoggedIn(id))throw new Error('地址可能已添加，但会话已变化，请先到官网核对结果。');
      return result;
    }finally{publishingAddresses.delete(id);}
  }));
  handle('add-cards',cards=>mutate(()=>store.addCards(cards)));
  handle('update-card',(id,patch)=>mutate(()=>store.updateCard(id,patch)));
  handle('settings',patch=>mutate(()=>store.updateSettings(patch)));
  handle('favorite',id=>mutate(()=>store.favoriteProduct(id)));
  handle('merge',ids=>mutate(()=>store.mergeProducts(ids)));
  handle('add-cart',(productId,cardId,quantity,sourceId)=>mutate(()=>store.addToCart(productId,cardId,quantity,sourceId)));
  handle('update-cart',(id,quantity)=>mutate(()=>store.updateCart(id,quantity)));
  handle('open-card',remote(openCard));handle('open-product',remote(openProduct)); handle('sync-card',remote(syncCard));handle('checkout',remote(checkout));
  handle('sync-all',remote(()=>syncManager.all(store.getViewState().cards.filter(card=>!card.archived).map(card=>card.id),(id,context)=>performSync(id,context))));
  handle('data-folder',()=>shell.openPath(dataDirectory).then(error=>{if(error)throw new Error(error);}));
  handle('export',async(passphrase:string)=>{
    const backup=backupService.export(passphrase);
    const result=await dialog.showSaveDialog(mainWindow!,{title:'保存加密备份',defaultPath:`关爱通备份-${new Date().toISOString().slice(0,10)}.gathub`,filters:[{name:'加密卡管家备份',extensions:['gathub']}]});
    if(result.canceled||!result.filePath)return false;
    atomicWrite(result.filePath,backup);return true;
  });
  handle('import',async(passphrase:string)=>{
    const result=await dialog.showOpenDialog(mainWindow!,{title:'恢复加密备份',properties:['openFile'],filters:[{name:'统一备份或旧版备份',extensions:['gathub','gataddr']}]});
    if(result.canceled)return null;
    if(statSync(result.filePaths[0]).size>32*1024*1024)throw new Error('备份文件过大');
    const prepared=backupService.prepare(readFileSync(result.filePaths[0],'utf8'),passphrase);
    if(!await confirmRestore(prepared))return null;
    await applyRestore(prepared);const state=store.getState();notify(state);return state;
  });
  handle('diagnostics',async()=>{
    const result=await dialog.showSaveDialog(mainWindow!,{title:'保存脱敏诊断报告',defaultPath:'关爱通诊断.json',filters:[{name:'脱敏诊断报告',extensions:['json']}]});
    if(result.canceled||!result.filePath)return false;
    atomicWrite(result.filePath,JSON.stringify({...diagnosticSummary(store.getState()),syncTasks:syncManager.list().map(task=>({id:task.id,batchId:task.batchId,cardId:task.cardId,status:task.status,phase:task.phase,page:task.page,completed:task.completed,total:task.total,errorKind:task.errorKind,endpoint:task.endpoint,startedAt:task.startedAt,finishedAt:task.finishedAt}))},null,2));return true;
  });
}
async function confirmRestore(prepared:PreparedRestore):Promise<boolean>{
  const state=prepared.data?.state;
  const details=state?[`卡片 ${state.cards.length} 张（归档 ${state.cards.filter(card=>card.archived).length} 张）`,`商品 ${state.products.length} 件 / 来源报价 ${state.products.reduce((sum,product)=>sum+product.offers.length,0)} 条`,`收藏 ${state.products.filter(product=>product.favorite).length} 件 / 清单 ${state.cart.length} 项 / 订单 ${state.orders.length} 笔`]:[];
  details.push(prepared.addresses===null?'旧版卡片备份：当前地址簿保留':`收货地址 ${prepared.addresses.length} 条`);
  if(prepared.exportedAt)details.push(`备份时间：${new Date(prepared.exportedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`);
  details.push(prepared.data?'恢复前会自动备份当前数据库。卡片恢复后需重新官网登录。':'恢复前会自动备份当前数据库。');
  const result=await dialog.showMessageBox(mainWindow!,{type:'question',title:'预览备份内容',message:prepared.kind==='addresses'?'将替换本地地址簿':prepared.kind==='cards'?'将替换卡片、商品、清单和订单':'将替换卡片数据与本地地址簿',detail:details.join('\n'),buttons:['取消','确认恢复'],defaultId:0,cancelId:0,noLink:true});
  return result.response===1;
}
async function applyRestore(prepared:PreparedRestore):Promise<void>{
  if(restoring)throw new Error('另一项恢复正在进行');
  if(prepared.data&&(remoteOperations||syncManager.running||runningSync.size||publishingAddresses.size||cardWindows.size||automaticWindows.size||store.getViewState().cards.some(card=>loginCoordinator.isRunning(card.id))))throw new Error('请先等待官网操作完成，并关闭官网窗口后恢复卡片备份');
  restoring=true;
  try{
    await sessionVault.flush();
    await database.enqueueWrite(()=>backupService.apply(prepared));
    if(prepared.data){
      sessionEpoch++;
      syncManager=new SyncManager({concurrency:()=>store.getViewState().settings.syncConcurrency??2,persist:task=>{void database.enqueueWrite(()=>database.saveSyncTask(task)).catch(()=>{});},changed:notifyTasks,initial:database.recoverInterruptedTasks()});
      notifyTasks(syncManager.list());
      for(const timer of sessionTimers.values())clearTimeout(timer);
      sessionTimers.clear();pendingDestinations.clear();failedRestores.clear();
      const previous=[...sessions.values()];sessions.clear();sessionReady.clear();
      // A failed browser cleanup must not retain an old session under restored card IDs.
      await Promise.allSettled(previous.map(ses=>ses.clearStorageData()));
    }
  }finally{restoring=false;}
}
async function bootstrap() {
  const file=process.env.HUB_BOOTSTRAP_FILE;if(!file)return;
  const path=resolve(file);
  const privatePath=relative(resolve(process.cwd(),'.private'),path);
  if(!privatePath||privatePath==='..'||privatePath.startsWith('..'+sep)||isAbsolute(privatePath))throw new Error('开发导入文件必须位于项目 .private 目录');
  const seed=JSON.parse(readFileSync(path,'utf8'));
  if(!Array.isArray(seed.cards))throw new Error('开发导入格式无效');
  const state=store.getState();
  const missing=seed.cards.filter((c:any)=>!state.cards.some(existing=>existing.number===c.number));
  if(missing.length)store.addCards(missing.map((c:any)=>({number:c.number,password:c.password,label:c.label})));
  for(const item of seed.cards) {
    const card=store.getViewState().cards.find(c=>c.number===item.number)!;
    const ses=await cardSession(card.id);
    if(item.cookies)for(const c of normalizeOfficialCookies(item.cookies))await ses.cookies.set(officialCookieDetails(c));
    if(item.snapshot)store.applySnapshot(card.id,await fetchSnapshot(async(p,params)=>{
      if(p==='common/getCurrentInfo')return item.snapshot.current;
      if(p==='product/list')return Number(params?.page)===1?item.snapshot.products:{code:0,data:{data_list:[],total_count:0,has_next:false}};
      return item.snapshot.orders;
    },card));
    await saveSession(card.id);
  }
  unlinkSync(path);notify();
}
app.whenReady().then(async()=>{
  try {
    if(!safeStorage.isEncryptionAvailable()||(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text'))throw new Error('系统安全存储不可用，无法安全保存卡号密码。请确认当前系统账户的安全存储可用后重试。');
    dataDirectory=join(app.getPath('userData'),'vault');mkdirSync(dataDirectory,{recursive:true,mode:0o700});chmodSync(dataDirectory,0o700);
    const storageOptions={directory:dataDirectory,encryptString:(v:string)=>safeStorage.encryptString(v),decryptString:(v:Buffer)=>safeStorage.decryptString(v)};
    database=openStorage(storageOptions);
    store=new HubStore({...storageOptions,repository:database,lightweightResults:true});
    sessionVault=new SessionVault({...storageOptions,repository:database});
    addressVault=new AddressVault({...storageOptions,repository:database});
    backupService=new BackupService(database,store,addressVault);
    const taskOptions={concurrency:()=>store.getViewState().settings.syncConcurrency??2,persist:(task:SyncTask)=>{const clean={...task,message:redactText(task.message,store.getViewState().cards.map(card=>card.number))};void database.enqueueWrite(()=>database.saveSyncTask(clean)).catch(()=>{});},changed:notifyTasks};
    syncManager=new SyncManager({...taskOptions,initial:database.recoverInterruptedTasks()});
    releaseService=new ReleaseService(app.getVersion(),process.platform,process.arch,fetch,database,url=>shell.openExternal(url));
    mainWindow=new BrowserWindow({width:1420,height:960,minWidth:940,minHeight:650,title:'关爱通卡管家',backgroundColor:'#f7f8fa',webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    mainWindow.on('closed',()=>app.quit());
    mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    mainWindow.webContents.on('will-navigate',event=>event.preventDefault());
    registerIPC();
    if(process.env.HUB_DEV_URL)await mainWindow.loadURL('http://127.0.0.1:5173');else await mainWindow.loadFile(join(__dirname,'../dist/index.html'));
    await bootstrap();
    if(process.env.HUB_OPEN_CARD){const card=store.getViewState().cards.find(c=>c.number===process.env.HUB_OPEN_CARD);if(card)await openCard(card.id);}
    if(process.env.HUB_SMOKE_OUTPUT){
      const results=[];for(const card of store.getViewState().cards)results.push(await syncCard(card.id));
      atomicWrite(process.env.HUB_SMOKE_OUTPUT,JSON.stringify({results:results.map(result=>({...result,message:redactText(result.message)})),summary:diagnosticSummary(store.getState()),encrypted:safeStorage.isEncryptionAvailable()},null,2));
      if(process.env.HUB_SCREENSHOT_OUTPUT){await new Promise(r=>setTimeout(r,600));const shot=await mainWindow.webContents.capturePage();writeFileSync(process.env.HUB_SCREENSHOT_OUTPUT,shot.toPNG());}
    }
  }catch(error){dialog.showErrorBox('卡管家启动失败',error instanceof Error?error.message:'未知错误');app.quit();}
});
app.on('window-all-closed',()=>{app.quit();});
app.on('before-quit',event=>{
  if(quitting||!database)return;
  event.preventDefault();quitting=true;syncManager?.cancel();
  for(const timer of sessionTimers.values())clearTimeout(timer);
  Promise.allSettled([...sessions.keys()].map(id=>saveSession(id))).then(()=>sessionVault?.flush()).finally(async()=>{await database.flush();try{database.close();}finally{app.quit();}}).catch(()=>{});
});
