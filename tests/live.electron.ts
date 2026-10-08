import { app,BrowserWindow,dialog,safeStorage } from 'electron';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { openStorage } from '../electron/storage-migration';
import { HubStore } from '../electron/store';
import { AddressVault } from '../electron/addresses';
import { SessionVault } from '../electron/session-vault';
import { BackupService } from '../electron/backup-service';
import { maskCardNumber,redactText } from '../electron/redaction';
import { DEFAULT_PRODUCT_QUERY,DEFAULT_ORDER_QUERY,type SyncTask } from '../src/shared/operations';
import type { AppState,HubAPI,AddCardInput } from '../src/shared/types';

const reportPath=process.env.HUB_LIVE_REPORT!;
const appEntry=process.env.HUB_LIVE_ENTRY!;
let credentials:AddCardInput[]=[];
let onlyFailed=false;
let inspectionOnly=false;
const enrollment=(async()=>{const response=await fetch(`http://127.0.0.1:${process.env.HUB_LIVE_INPUT_PORT}`,{headers:{Authorization:`Bearer ${process.env.HUB_LIVE_INPUT_TOKEN}`},credentials:'omit',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('临时凭据通道不可用');const value=await response.json();inspectionOnly=value.inspect===true;if(!inspectionOnly&&(!Array.isArray(value.cards)||value.cards.length>100))throw new Error('卡片输入无效');credentials=value.cards??[];onlyFailed=value.onlyFailed===true||inspectionOnly;return credentials;})();
const report:Record<string,unknown>={version:1,status:'starting',startedAt:new Date().toISOString(),cards:[],checks:{}};
const secrets=()=>credentials.flatMap(card=>[card.number,card.password]);
const clean=(error:unknown)=>redactText(error instanceof Error?error.message:String(error),secrets());
function emit(value:unknown){console.log('LIVE_EVENT '+JSON.stringify(value));}
function save(){writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});}
function removeTemporaryRestore(path:string){const resolved=resolve(path);if(!resolved.startsWith(resolve(tmpdir())+sep)||!resolved.split(sep).at(-1)!.startsWith('gat-live-restore-'))throw new Error('临时恢复目录路径核对失败');rmSync(resolved,{recursive:true,force:true});}
dialog.showErrorBox=(title,message)=>{report.status='startup-failed';report.error=clean(`${title}: ${message}`);save();emit({type:'failed',message:report.error});app.exit(1);};
let handled=false;
let mainAssigned=false;
app.on('browser-window-created',(_event,window)=>{
  if(mainAssigned){window.on('show',()=>emit({type:'manual-window',message:'官网验证需要手动接续'}));return;}
  mainAssigned=true;
  window.hide();window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load',()=>{if(handled)return;handled=true;void test(window);});
});
async function test(window:BrowserWindow){
  let originalSettings:AppState['settings']|null=null;
  let inputIds:string[]=[];
  const invoke=async<T>(method:keyof HubAPI,...args:unknown[]):Promise<T>=>window.webContents.executeJavaScript(`window.hub[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  try{
    await enrollment;
    assert.ok(credentials.every(card=>/^\d{6,32}$/.test(card.number)&&typeof card.password==='string'&&card.password.length>0));
    assert.equal(new Set(credentials.map(card=>card.number)).size,credentials.length);
    await invoke('getViewState');
    const options={directory:join(app.getPath('userData'),'vault'),encryptString:(value:string)=>safeStorage.encryptString(value),decryptString:(value:Buffer)=>safeStorage.decryptString(value)};
    const safety=openStorage(options);report.safetyBackup=safety.backup('before-live-test');
    const existing=new HubStore({...options,repository:safety});
    if(inspectionOnly)credentials=existing.getState().cards.map(card=>({number:card.number,password:existing.getPassword(card.id)}));
    for(const input of credentials){const card=existing.getState().cards.find(card=>card.number===input.number);if(card&&existing.getPassword(card.id)!==input.password)throw new Error('已保存的卡密与本次输入不一致');}
    safety.close();
    const before=await invoke<AppState>('getState');originalSettings=before.settings;
    const missing=credentials.filter(input=>!before.cards.some(card=>card.number===input.number));
    if(missing.length)await invoke('addCards',missing.map(input=>({...input,label:`福利卡 ${maskCardNumber(input.number)}`})));
    const enrolled=await invoke<AppState>('getState');
    const cards=credentials.map(input=>enrolled.cards.find(card=>card.number===input.number)!);inputIds=cards.map(card=>card.id);
    report.added=missing.length;report.existing=credentials.length-missing.length;report.status='syncing';save();
    emit({type:'enrolled',added:missing.length,existing:credentials.length-missing.length,totalRequested:credentials.length});
    if(!inspectionOnly)await invoke('updateSettings',{autoLogin:true,syncConcurrency:2});
    const lastProgress=new Map<string,string>();
    const timer=setInterval(()=>void invoke<SyncTask[]>('getSyncTasks').then(tasks=>{
      const latest=[...new Map(tasks.filter(task=>inputIds.includes(task.cardId)).reverse().map(task=>[task.cardId,task])).values()];
      for(const task of latest){
        const key=JSON.stringify([task.id,task.status,task.phase,task.page]);if(lastProgress.get(task.cardId)===key)continue;lastProgress.set(task.cardId,key);
        const card=cards.find(card=>card.id===task.cardId)!;
        emit({type:'sync',card:maskCardNumber(card.number),status:task.status,phase:task.phase,page:task.page,completed:task.completed,total:task.total,...(task.status==='failed'?{message:clean(task.message),errorKind:task.errorKind}:{})});
      }
    }).catch(()=>{}),1500);
    let results:{cardId:string;ok:boolean;message:string}[];
    try{
      if(onlyFailed){const targets=inspectionOnly?[]:cards.filter(card=>card.status==='pending'||card.status==='error'||card.syncedAt===null);emit({type:'retry-targets',cards:targets.map(card=>maskCardNumber(card.number))});const fresh=await Promise.all(targets.map(card=>invoke<{cardId:string;ok:boolean;message:string}>('syncCard',card.id)));results=cards.map(card=>fresh.find(result=>result.cardId===card.id)??{cardId:card.id,ok:!!card.syncedAt,message:inspectionOnly?'重启后读取保存的数据与会话':'已恢复此前同步快照与会话，本轮只重试失败卡'});}
      else results=enrolled.cards.length===inputIds.length?await invoke('syncAll'):await Promise.all(inputIds.map(id=>invoke<{cardId:string;ok:boolean;message:string}>('syncCard',id)));
    }finally{clearInterval(timer);}
    const state=await invoke<AppState>('getState');
    const rows=[];
    for(const card of state.cards.filter(card=>inputIds.includes(card.id))){
      const outcome=results.find(result=>result.cardId===card.id)!;
      const products=state.products.filter(product=>product.offers.some(offer=>offer.cardId===card.id));
      const offers=products.reduce((sum,product)=>sum+product.offers.filter(offer=>offer.cardId===card.id).length,0);
      let addressCount:number|null=null,addressError:string|null=null;
      if(outcome.ok){try{const addresses=await invoke<unknown[]>('getOfficialAddresses',card.id);addressCount=addresses.length;}catch(error){addressError=clean(error);}}
      const query=await invoke<{total:number;items:unknown[]}>('queryProducts',{...DEFAULT_PRODUCT_QUERY,cardId:card.id});
      assert.equal(query.total,products.length);assert.ok(query.items.length<=24);
      const orders=state.orders.filter(order=>order.cardId===card.id);
      const orderPage=await invoke<{total:number}>('queryOrders',{...DEFAULT_ORDER_QUERY,cardId:card.id});assert.equal(orderPage.total,orders.length);
      rows.push({card:maskCardNumber(card.number),ok:outcome.ok,balance:card.balance,unit:card.balanceUnit,status:card.status,products:products.length,offers,orders:orders.length,addressCount,addressError,message:clean(outcome.message)});
      emit({type:'card-result',...rows.at(-1)});
    }
    report.cards=rows;report.summary={cards:state.cards.length,products:state.products.length,offers:state.products.reduce((n,item)=>n+item.offers.length,0),orders:state.orders.length};
    report.status=rows.every(card=>card.ok)?'synced':'partial';save();
    const successful=state.cards.find(card=>inputIds.includes(card.id)&&results.find(result=>result.cardId===card.id)?.ok&&!card.archived);
    let cancelled=false,retried=false;
    if(successful&&!inspectionOnly){
      const baseline={balance:successful.balance,products:state.products,orders:state.orders};
      const pending=invoke<{cancelled?:boolean}>('syncCard',successful.id);await invoke('cancelSync',successful.id);const result=await pending;cancelled=!!result.cancelled;
      const after=await invoke<AppState>('getState');if(cancelled){assert.equal(after.cards.find(card=>card.id===successful.id)!.balance,baseline.balance);assert.deepEqual(after.products,baseline.products);assert.deepEqual(after.orders,baseline.orders);}
      const retry=await invoke<{cardId:string;ok:boolean}[]>('retryFailedSync');retried=!!retry.find(row=>row.cardId===successful.id)?.ok;
      emit({type:'cancellation-retry',cancelled,preserved:cancelled,retried});
    }
    if(!inspectionOnly)await invoke('updateSettings',originalSettings);originalSettings=null;
    const database=openStorage(options),stored=new HubStore({...options,repository:database}),book=new AddressVault({...options,repository:database});
    for(const input of credentials){const card=stored.getState().cards.find(card=>card.number===input.number)!;assert.equal(stored.getPassword(card.id),input.password);}
    const portablePassword=randomBytes(24).toString('hex'),contents=new BackupService(database,stored,book).export(portablePassword);
    const temporary=mkdtempSync(join(tmpdir(),'gat-live-restore-'));
    try{
      const destination=openStorage({...options,directory:temporary});
      try{const target=new HubStore({...options,directory:temporary,repository:destination}),addresses=new AddressVault({...options,directory:temporary,repository:destination});const service=new BackupService(destination,target,addresses);service.apply(service.prepare(contents,portablePassword));assert.deepEqual(target.getState(),stored.getState());assert.deepEqual(addresses.list(),book.list());assert.equal(new SessionVault({...options,directory:temporary,repository:destination}).load(inputIds[0]).length,0);}finally{destination.close();}
    }finally{removeTemporaryRestore(temporary);}
    const snapshot=database.backup('after-live-test'),bytes=readFileSync(snapshot);
    assert.equal(credentials.some(input=>bytes.includes(Buffer.from(input.number))),false,'数据库中存在完整卡号明文');
    report.checks={queries:true,credentialReadback:true,portableRestore:true,cookiesExcludedFromPortableBackup:true,noPlaintextCardNumbers:true,...(inspectionOnly?{restartSessions:rows.every(row=>row.addressCount!==null&&row.addressError===null)}:{cancellation:cancelled,retry:retried})};
    database.close();report.status=rows.every(card=>card.ok)?'passed':'partial';report.finishedAt=new Date().toISOString();save();emit({type:'completed',status:report.status,summary:report.summary,checks:report.checks});
    app.quit();
  }catch(error){
    report.status='failed';report.error=clean(error);report.finishedAt=new Date().toISOString();
    if(originalSettings){try{await invoke('updateSettings',originalSettings);}catch{}}
    save();emit({type:'failed',message:report.error});app.quit();
  }
}
require(appEntry);
