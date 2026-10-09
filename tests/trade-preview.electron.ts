import assert from 'node:assert/strict';
import { app,dialog,safeStorage,session } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStorage } from '../electron/storage-migration';
import { HubStore } from '../electron/store';
import { AddressVault } from '../electron/addresses';
import { BackupService } from '../electron/backup-service';
import { normalizeOfficialCookies,officialCookieDetails } from '../electron/session-vault';
import { API_BASE } from '../electron/adapter';
import { redactText } from '../electron/redaction';
import type { HubAPI,Product,ProductOffer } from '../src/shared/types';

const root=process.env.HUB_TRADE_LIVE_ROOT!,entry=process.env.HUB_TRADE_LIVE_ENTRY!;
assert.ok(root&&entry&&process.env.HUB_TRADE_PREVIEW_ONLY==='1');
const originalUserData=join(app.getPath('appData'),'guanaitong-hub');
app.setName('guanaitong-hub');app.setPath('userData',originalUserData);app.on('window-all-closed',()=>{});
const output=resolve('.private/trade-preview');mkdirSync(output,{recursive:true,mode:0o700});
const report:any={status:'starting',previewOnly:true,realSubmitApiCalls:0,finalRequests:0,blockedFinalRequests:0,requests:[],startedAt:new Date().toISOString()};
let number='',password='',handled=false;
const clean=(error:unknown)=>redactText(error instanceof Error?error.message:String(error),[number,password]);
const save=()=>writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2),{mode:0o600});
const emit=(value:unknown)=>console.log('PREVIEW_EVENT '+JSON.stringify(value));
const readPaths:Record<string,string>={'common/getCurrentInfo':'GET','common/getCommonInfo':'POST','common/getCurrentUserInfo':'GET','common/getTopic':'GET','common/getKey':'GET','encrypt/getInterfaceTransferRSAPublicKey':'POST','address/list':'GET','product/detail':'GET','product/check':'POST','cart/getSettlementInfo':'POST','product/list':'GET','card/getProductHomeUrl':'GET','exchangeOrder/list':'GET','product/cmsQueryProduct':'POST','product/cmsQueryProductCategory':'POST'};
app.on('session-created',ses=>{
  ses.webRequest.onBeforeRequest({urls:['https://a.guanaitong.com/card-exchange-bff/api/*']},(details,callback)=>{
    const path=new URL(details.url).pathname.replace('/card-exchange-bff/api/','');
    if(path==='exchangeOrder/exchange'){report.blockedFinalRequests++;callback({cancel:true});return;}
    const allowed=readPaths[path]===details.method||path.startsWith('login/')||path.startsWith('captcha/');
    report.requests.push({path,method:details.method,allowed});callback({cancel:!allowed});
  });
});
dialog.showErrorBox=(_title,message)=>{report.status='failed';report.error=clean(message);save();emit({status:'failed',message:report.error,finalRequests:0});app.exit(1);};

app.whenReady().then(async()=>{
  let source:DatabaseSync|undefined;
  try{
    const response=await fetch(`http://127.0.0.1:${process.env.HUB_TRADE_LIVE_PORT}`,{headers:{Authorization:`Bearer ${process.env.HUB_TRADE_LIVE_TOKEN}`},credentials:'omit',signal:AbortSignal.timeout(10000)});
    const input=await response.json();number=input.number;password=input.password;
    const decode=(bytes:any)=>JSON.parse(safeStorage.decryptString(Buffer.from(bytes)));
    source=new DatabaseSync(join(originalUserData,'vault','hub.sqlite'),{readOnly:true});
    report.originalSchemaVersion=source.prepare('PRAGMA user_version').get()!.user_version;
    const row=source.prepare('SELECT id,payload,credential FROM cards ORDER BY position').all().find(row=>decode(row.credential).number===number);
    if(!row||decode(row.credential).password!==password)throw new Error('指定卡密与已有本地数据不一致，测试未继续');
    const originalCard={...decode(row.payload),id:String(row.id),number,hasPassword:true};
    const chosen=source.prepare('SELECT p.id,p.payload AS product,o.payload AS offer,o.source_id FROM offers o JOIN products p ON p.id=o.product_id WHERE o.card_id=? AND (o.stock IS NULL OR o.stock>0) ORDER BY o.price IS NULL,o.price LIMIT 30').all(String(row.id)).find(row=>String(row.source_id).endsWith(':1'));
    if(!chosen)throw new Error('该卡没有可供预览的普通商品缓存');
    const offer:ProductOffer={...decode(chosen.offer),cardId:originalCard.id,sourceId:String(chosen.source_id)};
    const product:Product={...decode(chosen.product),id:String(chosen.id),offers:[offer]};
    let cookies:any[]=[];const saved=source.prepare('SELECT payload FROM sessions WHERE card_id=?').get(String(row.id));if(saved){const data=decode(saved.payload);cookies=data.cookies??data;}
    const cache=resolve('.private/trade-development/probe-session.enc');if(existsSync(cache)){const data=decode(readFileSync(cache));if(data.owner===number)cookies=data.cookies;}
    source.close();source=undefined;
    // Decryption above uses the original key identity. All new application data
    // below is in a disposable isolated directory, never the original vault.
    mkdirSync(join(root,'appdata'),{recursive:true});app.setPath('appData',join(root,'appdata'));
    app.on('browser-window-created',(_event,window)=>{
      if(handled)return;handled=true;window.hide();window.webContents.setBackgroundThrottling(false);
      window.webContents.once('did-finish-load',async()=>{
        try{
          const evaluate=(code:string)=>window.webContents.executeJavaScript(code);
          const invoke=async(method:keyof HubAPI,...args:unknown[])=>evaluate(`window.hub[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
          const wait=async(code:string)=>{for(let attempt=0;attempt<600;attempt++){if(await evaluate(code))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('预览界面等待超时');};
          await wait("Boolean(window.hub && document.querySelector('.app-shell'))");
          const options={directory:join(root,'fixture'),encryptString:(value:string)=>safeStorage.encryptString(value),decryptString:(value:Buffer)=>safeStorage.decryptString(value)};
          const db=openStorage(options),store=new HubStore({...options,repository:db}),book=new AddressVault({...options,repository:db});
          const added=store.addCards([{number,password,label:'预览测试卡'}]).cards[0];
          offer.cardId=added.id;product.offers=[offer];
          store.applySnapshot(added.id,{card:{...originalCard,id:undefined,status:'active',archived:false,error:null},products:[product]});
          store.addToCart(product.id,added.id,1,offer.sourceId);store.updateSettings({autoLogin:true,maskNumbers:true});
          const passphrase=randomBytes(24).toString('hex'),backup=join(root,'fixture.gathub');writeFileSync(backup,new BackupService(db,store,book).export(passphrase),{mode:0o600});db.close();
          dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[backup]})) as typeof dialog.showOpenDialog;
          dialog.showMessageBox=(async()=>({response:1,checkboxChecked:false})) as typeof dialog.showMessageBox;
          await invoke('importData',passphrase);
          const ses=session.fromPartition(`card-1-${added.id}`);for(const cookie of normalizeOfficialCookies(cookies))await ses.cookies.set(officialCookieDetails(cookie));
          const current=async()=>{const response=await ses.fetch(API_BASE+'common/getCurrentInfo',{credentials:'include',redirect:'error',signal:AbortSignal.timeout(20000)});const body=await response.json();if(body.code!==0||String(body.data?.card_code)!==number)throw new Error('当前测试会话需要重新登录');return body.data;};
          let before:any;try{before=await current();}catch{/* The application may recover its isolated session on context loading. */}
          emit({stage:'native-context',previewOnly:true});
          await evaluate("document.querySelector('button[aria-label=\"兑换清单\"]').click()");await wait("Boolean(document.querySelector('.cart-group'))");
          await evaluate("document.querySelector('.cart-group .button.primary').click()");
          await wait("Boolean(document.querySelector('select[aria-label=\"结算规格 1\"]')) || Boolean(document.querySelector('.trade-dialog [role=alert]'))");
          if(await evaluate("Boolean(document.querySelector('.trade-dialog [role=alert]'))"))throw new Error(await evaluate("document.querySelector('.trade-dialog [role=alert]').textContent"));
          if(!before)before=await current();
          await evaluate("(()=>{const select=document.querySelector('select[aria-label=\"结算规格 1\"]');if(!select.value){const option=[...select.options].find(option=>option.value&&!option.disabled);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));}})()");
          await wait("[...document.querySelectorAll('.trade-dialog button')].some(button=>button.textContent==='获取结算预览'&&!button.disabled)");
          emit({stage:'settlement-preview',finalSubmitDisabled:true});
          await evaluate("[...document.querySelectorAll('.trade-dialog button')].find(button=>button.textContent==='获取结算预览').click()");
          await wait("Boolean(document.querySelector('.trade-confirmation')) || Boolean(document.querySelector('.trade-dialog [role=alert]'))");
          if(await evaluate("Boolean(document.querySelector('.trade-dialog [role=alert]'))"))throw new Error(await evaluate("document.querySelector('.trade-dialog [role=alert]').textContent"));
          assert.equal(await evaluate("document.querySelector('button[aria-label=\"确认提交扣卡订单\"]').disabled"),true);
          // Deliberately never invoke submitOrder, even to test its rejection with real credentials.
          const after=await current();assert.equal(after.balance,before.balance);assert.equal((await invoke('getTradeAttempts')).length,0);
          const original=new DatabaseSync(join(originalUserData,'vault','hub.sqlite'),{readOnly:true});assert.equal(original.prepare('PRAGMA user_version').get()!.user_version,report.originalSchemaVersion);original.close();
          writeFileSync(join(output,'preview.png'),(await window.webContents.capturePage(undefined,{stayHidden:true})).toPNG(),{mode:0o600});
          report.status='preview-complete';report.nativeUI=true;report.balanceUnchanged=true;report.originalDatabaseNotMigrated=true;report.finalButtonDisabled=true;report.completedAt=new Date().toISOString();save();
          emit({status:'preview-complete',nativeUI:true,balanceUnchanged:true,finalSubmitApiCalls:0,finalRequests:0,originalDatabaseNotMigrated:true,report:'.private/trade-preview/result.json'});app.quit();
        }catch(error){report.status='failed';report.error=clean(error);save();emit({status:'failed',message:report.error,finalRequests:0});app.exit(1);}
      });
    });
    require(entry);
  }catch(error){source?.close();report.status='failed';report.error=clean(error);save();emit({status:'failed',message:report.error,finalRequests:0});app.exit(1);}
});
