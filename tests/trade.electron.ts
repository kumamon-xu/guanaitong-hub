import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { app, session, dialog, safeStorage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '../electron/storage-migration';
import { HubStore } from '../electron/store';
import { AddressVault } from '../electron/addresses';
import { BackupService } from '../electron/backup-service';
import type { HubAPI, Product } from '../src/shared/types';
import { API_BASE } from '../electron/adapter';
import type { TradeAttempt } from '../src/shared/trade';

const root=process.env.HUB_TRADE_TEST_ROOT!,mode=process.env.HUB_TRADE_TEST_MODE!;
assert.ok(root&&['preview','submit'].includes(mode));
mkdirSync(join(root,'appdata'),{recursive:true});app.setPath('appData',join(root,'appdata'));
let submits=0,orderCreated=false;const number='111111111111';
dialog.showErrorBox=(_title,message)=>{console.error(message);app.exit(1);};
app.whenReady().then(()=>{
  // No real network transport exists in this test process.
  const prototype=Object.getPrototypeOf(session.defaultSession);
  prototype.fetch=async(input:unknown,options:RequestInit={})=>{
    const url=new URL(String(input));if(!url.href.startsWith(API_BASE))throw new Error('Network disabled for synthetic trade check');
    const body=String(options.body??'');
    const path=url.pathname.replace('/card-exchange-bff/api/',''),params=body?(body.startsWith('{')?JSON.parse(body):Object.fromEntries(new URLSearchParams(body))):Object.fromEntries(url.searchParams);
    let data:any;
    if(path==='common/getCurrentInfo')data={card_code:number,balance:orderCreated?50:100,is_usable:1,limited_type:1,date_valid_to:'2040-10-09 23:59:59'};
    else if(path==='common/getCommonInfo')data={current_user_info:{post_address_type:1}};
    else if(path==='address/list')data={data_list:[{id:'test-address',card_code:number,is_default:1,area:'上海市 上海市 黄浦区',name:'合成收件人',mobile:'13800138000',address:'合成地址 1 号',province_id:'31',city_id:'3101',district_id:'310101',town_id:'310101001'}],total_count:1,has_next:false};
    else if(path==='product/detail')data={product_code:'test-product',inventory_id:'test-pool',product_type:1,type:1,title:'合成兑换商品',is_multi_card:1,spu_stock:10,main_pic_urls:[],sku_info:{first:{code:'test-sku',name:'合成规格',price:25,stock:10}}};
    else if(path==='product/check')data={result:true};
    else if(path==='cart/getSettlementInfo'){const row=params.settlement_info_obj_list[0];data={total_amount:25*row.purchase_num,total_pieces:row.purchase_num,is_need_verify:2,is_jd_direct_charge_product:2,is_exist_cycle_product:2,invalid_product_list:[],settlement_item:[{deliver_fee:0,product_list:[{spu_code:'test-product',sku_code:'test-sku',inventory_id:'test-pool',product_type:1,product_title:'合成兑换商品',sku_name:'合成规格',purchase_num:row.purchase_num,price:25,stock_num:10,is_valid:true,offline_store_delivery_type:1}]}]};}
    else if(path==='exchangeOrder/exchange'){assert.equal(mode,'submit');submits++;assert.equal(submits,1);orderCreated=true;data={shop_order_code:'test-order',seller_order_code:'test-seller-order'};}
    else if(path==='exchangeOrder/getPaymentResult')data={result:true};
    else if(path==='exchangeOrder/list')data={data_list:orderCreated?[{shop_order_code:'test-order',seller_order_code:'test-seller-order',card_code:number,trade_status:2,order_price:50,time_order_created:Date.now(),order_product_list:[{product_name:'合成兑换商品',purchase_num:2}]}]:[],total_count:orderCreated?1:0,has_next:false};
    else if(path==='product/list')data={data_list:[{product_code:'test-product',inventory_id:'test-pool',product_type:1,product_title:'合成兑换商品',price:25,max_price:25,is_sold_out:0}],total_count:1,has_next:false};
    else if(path==='card/getProductHomeUrl')data={pc_product_home_url:'https://a.guanaitong.com/synthetic-home'};
    else throw new Error('Unexpected synthetic endpoint '+path);
    return Response.json({code:0,data});
  };
});
app.on('browser-window-created',(_event,window)=>{
  window.hide();window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load',async()=>{
    try{
      const evaluate=(code:string)=>window.webContents.executeJavaScript(code);
      const wait=async(code:string)=>{for(let attempt=0;attempt<100;attempt++){if(await evaluate(code))return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Native trade condition timed out: '+code);};
      const invoke=async(method:keyof HubAPI,...args:unknown[])=>evaluate(`window.hub[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      await wait("Boolean(window.hub && document.querySelector('.app-shell'))");
      const options={directory:join(root,'fixture'),encryptString:(value:string)=>safeStorage.encryptString(value),decryptString:(value:Buffer)=>safeStorage.decryptString(value)};
      const db=openStorage(options),store=new HubStore({...options,repository:db}),addresses=new AddressVault({...options,repository:db});
      const card=store.addCards([{number,password:'synthetic-native-trade-password',label:'合成卡'}]).cards[0];
      const product:Product={id:'test-product-id',name:'合成兑换商品',brand:'',category:'食品',specification:'',image:'',favorite:false,mergeKey:'',offers:[{cardId:card.id,sourceId:'test-product:test-pool:1',price:25,priceUnit:'额度',stock:10,url:'https://a.guanaitong.com/festival-exchange-pc/product-detail',variant:'',syncedAt:''}]};
      store.applySnapshot(card.id,{card:{status:'active',balance:100,balanceUnit:'额度'},products:[product]});store.addToCart(product.id,card.id,2,product.offers[0].sourceId);
      const backup=join(root,'fixture.gathub');writeFileSync(backup,new BackupService(db,store,addresses).export('synthetic-backup-password'));db.close();
      dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[backup]})) as typeof dialog.showOpenDialog;
      dialog.showMessageBox=(async()=>({response:1,checkboxChecked:false})) as typeof dialog.showMessageBox;
      await invoke('importData','synthetic-backup-password');
      await evaluate("document.querySelector('button[aria-label=\"兑换清单\"]').click()");
      await wait("Boolean(document.querySelector('.cart-group'))");
      await evaluate("document.querySelector('.cart-group .button.primary').click()");
      await wait("Boolean(document.querySelector('select[aria-label=\"结算规格 1\"]'))");
      assert.equal(await evaluate("document.querySelector('select[aria-label=\"结算规格 1\"]').value"),'test-sku');
      assert.equal(await evaluate("document.querySelector('select[aria-label=\"结算收货地址\"]').value"),'test-address');
      await evaluate("[...document.querySelectorAll('.trade-dialog button')].find(button=>button.textContent==='获取结算预览').click()");
      await wait("Boolean(document.querySelector('.trade-confirmation'))");
      assert.ok((await evaluate("document.querySelector('.trade-totals').textContent")).includes('50'));
      assert.equal(submits,0);
      if(mode==='preview'){
        assert.equal(await evaluate("document.querySelector('button[aria-label=\"确认提交扣卡订单\"]').disabled"),true);
        const preview=await invoke('previewOrder',{cardId:card.id,addressId:'test-address',items:[{productId:product.id,sourceId:product.offers[0].sourceId,skuCode:'test-sku',quantity:2}]});
        await assert.rejects(invoke('submitOrder',{previewId:preview.id,digest:preview.digest,confirmDeduction:true,acceptAgreements:true}),/最终下单已禁用/);
        assert.equal((await invoke('getTradeAttempts')).length,0);assert.equal(submits,0);
        await evaluate("document.querySelector('button[aria-label=\"关闭结算\"]').click()");
        await wait("!document.querySelector('.trade-dialog')");
        const seedDb=openStorage(options),seedStore=new HubStore({...options,repository:seedDb}),seedBook=new AddressVault({...options,repository:seedDb});
        const other=seedStore.addCards([{number:'222222222222',password:'synthetic-history-card-password',label:'另一张合成卡'}]).cards[1];
        const owner=(number:string)=>createHash('sha256').update(JSON.stringify(['card',number])).digest('hex');
        const pending:TradeAttempt={id:'old-visible-attempt',cardId:card.id,cardKey:owner(number),fingerprint:'a'.repeat(64),previewDigest:'b'.repeat(64),status:'submitted',startedAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:01Z',deduction:50,balanceUnit:'额度',lines:[{productCode:'test-product',skuCode:'test-sku',inventoryId:'test-pool',name:'旧的待核对商品',specification:'合成规格',quantity:2,price:25}],orderCode:'test-order',sellerOrderCode:'test-seller-order',message:'等待核对',baselineOrders:[]};
        seedDb.saveTradeAttempt(pending);
        for(let index=0;index<120;index++){
          const base={...pending,cardId:other.id,cardKey:owner(other.number),lines:pending.lines.map(line=>({...line,name:'另一张合成卡交易 '+index})),startedAt:new Date(Date.parse('2026-10-02T00:00:00Z')+index*1000).toISOString()};
          seedDb.saveTradeAttempt({...base,id:'other-pending-'+index,status:'unknown',orderCode:null,sellerOrderCode:null});
          seedDb.saveTradeAttempt({...base,id:'other-completed-'+index,status:'succeeded'});
        }
        const largeBackup=join(root,'large-journal.gathub');writeFileSync(largeBackup,new BackupService(seedDb,seedStore,seedBook).export('synthetic-backup-password'));seedDb.close();
        dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[largeBackup]})) as typeof dialog.showOpenDialog;
        await invoke('importData','synthetic-backup-password');
        const journal=await invoke('getTradeAttempts');assert.equal(journal.length,221);assert.equal(journal.filter((row:any)=>['submitted','unknown','submitting'].includes(row.status)).length,121);assert.ok(journal.some((row:any)=>row.id===pending.id));
        await evaluate("document.querySelector('button[aria-label=\"订单记录\"]').click()");
        await wait("document.querySelector('.trade-attempts')?.textContent.includes('旧的待核对商品')");
        orderCreated=true;
        await evaluate("[...document.querySelectorAll('.trade-attempts article')].find(row=>row.textContent.includes('旧的待核对商品')).querySelector('button').click()");
        await wait("!document.querySelector('.trade-attempts')?.textContent.includes('旧的待核对商品')");
        const activeOptions={directory:join(app.getPath('userData'),'vault'),encryptString:options.encryptString,decryptString:options.decryptString};
        const activeDb=openStorage(activeOptions);assert.equal(activeDb.tradeAttempts().find(row=>row.id===pending.id)?.status,'succeeded');activeDb.close();assert.equal(submits,0);
      }else{
        await evaluate("document.querySelector('input[aria-label=\"确认扣卡额度\"]').click()");
        await wait("!document.querySelector('button[aria-label=\"确认提交扣卡订单\"]').disabled");
        await evaluate("document.querySelector('button[aria-label=\"确认提交扣卡订单\"]').click()");
        await wait("document.querySelector('.trade-receipt')?.textContent.includes('兑换成功')");
        assert.equal(submits,1);const records=await invoke('getTradeAttempts');assert.equal(records[0].status,'succeeded');assert.equal(records[0].orderCode,'test-order');
      }
      console.log(JSON.stringify({case:'native-trade-checkout',mode,ok:true,realNetworkRequests:0,syntheticSubmissions:submits,encrypted:true,ipc:true,ui:true}));app.quit();
    }catch(error){console.error(error);app.exit(1);}
  });
});
require(process.env.HUB_TRADE_TEST_ENTRY!);
