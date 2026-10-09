import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { HubStore } from '../electron/store';
import { createTradeTransport, TradeBusinessError, TradeTransportError, type TradeTransport } from '../electron/trade-client';
import { TradeService } from '../electron/trade-service';
import { normalizeSettlement, normalizeTradeProduct } from '../electron/trade-protocol';
import { validateIPC } from '../electron/ipc-validation';
import { mergeRestoredTradeAttempt } from '../electron/trade-records';
import type { PortableData } from '../electron/persistence';
import type { TradeAttempt, TradePreviewInput } from '../src/shared/trade';

function fixture(previewOnly=false) {
  let saved:PortableData|null=null;
  const store=new HubStore({directory:'.',repository:{filePath:'memory',loadHub:()=>saved,saveHub:data=>{saved=structuredClone(data);}},encryptString:()=>{throw new Error('unused');},decryptString:()=>{throw new Error('unused');}});
  const card=store.addCards([{number:'111111111111',password:'synthetic-trade-password',label:'合成卡'}]).cards[0];
  const offer={cardId:card.id,sourceId:'fixture-product:fixture-pool:1',price:1,priceUnit:'额度',stock:null,url:'https://a.guanaitong.com/festival-exchange-pc/product-detail',variant:'',syncedAt:''};
  store.applySnapshot(card.id,{card:{status:'active',balance:100},products:[{id:'fixture-product-id',name:'合成商品',brand:'',category:'',specification:'',image:'',favorite:false,mergeKey:'',offers:[offer]}]});
  const state={balance:100,currentNumber:card.number,price:30,stock:10,needVerify:2,failure:null as Error|null,hold:null as Promise<void>|null,orderCreated:false,paid:true,cashier:false,invalid:false,wrongSku:false,addressPhone:'13800138000',agreement:false,shipping:0,ledgerFailure:false,clock:Date.parse('2026-10-09T00:00:00Z'),calls:[] as string[],payload:null as any};
  const records=new Map<string,TradeAttempt>();
  const detail=()=>({product_code:'fixture-product',inventory_id:'fixture-pool',product_type:1,type:1,is_multi_card:1,title:'合成商品',sku_info:{first:{code:'fixture-sku',price:state.price,stock:state.stock,name:'原味',limit_purchase_num:null}},main_pic_urls:[],spu_stock:state.stock,package_item_list:null});
  const address=()=>({id:'fixture-address',card_code:card.number,is_default:1,name:'合成收件人',mobile:state.addressPhone,area:'上海市 上海市 黄浦区',address:'合成测试地址 1 号',house_no:'',province_id:'31',city_id:'3101',district_id:'310101',town_id:'310101001',zipcode:''});
  const transport:TradeTransport={
    async request(_id,path,params={}){
      state.calls.push(path);
      if(path==='common/getCurrentInfo')return{card_code:state.currentNumber,balance:state.balance,is_usable:state.balance?1:0,limited_type:1,date_valid_to:'2040-10-09 23:59:59'};
      if(path==='common/getCommonInfo')return{current_user_info:{post_address_type:1},current_info:{word_show_setting:state.agreement?{confirm_order_agreement_name:'合成商品协议',confirm_order_agreement_content:'这是合成测试协议正文。'}:{}}};
      if(path==='address/list')return{data_list:[address()],total_count:1,has_next:false};
      if(path==='product/detail')return detail();
      if(path==='product/check')return{result:!state.invalid};
      if(path==='cart/getSettlementInfo'){
        const rows=(params.settlement_info_obj_list as any[]).map(row=>({spu_code:'fixture-product',sku_code:state.wrongSku?'foreign-sku':row.sku_code,inventory_id:'fixture-pool',product_type:1,product_title:'合成商品',sku_name:'原味',purchase_num:row.purchase_num,price:state.price,stock_num:state.stock,is_valid:true,offline_store_delivery_type:1}));
        return{total_amount:rows.reduce((sum,row)=>sum+row.price*row.purchase_num,0)+state.shipping,total_pieces:rows.reduce((sum,row)=>sum+row.purchase_num,0),settlement_item:[{deliver_fee:state.shipping,product_list:rows}],invalid_product_list:[],is_need_verify:state.needVerify,is_jd_direct_charge_product:2,is_exist_cycle_product:2};
      }
      if(path==='exchangeOrder/list')return{data_list:state.orderCreated?[{shop_order_code:'fixture-order',seller_order_code:'fixture-seller-order',card_code:card.number,trade_status:state.paid?2:1}]:[],has_next:false,total_count:state.orderCreated?1:0};
      if(path==='exchangeOrder/getPaymentResult')return{result:state.paid};
      throw new Error('unexpected path '+path);
    },
    async exchange(_id,payload){state.calls.push('exchangeOrder/exchange');state.payload=structuredClone(payload);assert.equal([...records.values()].at(-1)?.status,'submitting');if(state.hold)await state.hold;if(state.failure)throw state.failure;state.orderCreated=true;return{shop_order_code:'fixture-order',seller_order_code:'fixture-seller-order',...(state.cashier?{cashier_url:'https://example.com/never-open-payment'}:{})};},
  };
  const ledger={list:()=>structuredClone([...records.values()]),put:async(value:TradeAttempt)=>{if(state.ledgerFailure)throw new Error('synthetic ledger failure');records.set(value.id,structuredClone(value));}};
  const service=new TradeService({store,transport,ledger,previewOnly,ensureLoggedIn:async()=>true,now:()=>state.clock});
  const input:TradePreviewInput={cardId:card.id,addressId:'fixture-address',items:[{productId:'fixture-product-id',sourceId:offer.sourceId,skuCode:'fixture-sku',quantity:2}]};
  const submit=(preview:any)=>service.submit({previewId:preview.id,digest:preview.digest,confirmDeduction:true,acceptAgreements:true});
  return{store,card,offer,state,records,ledger,service,input,detail,address,submit,transport};
}
const writes=(f:ReturnType<typeof fixture>)=>f.state.calls.filter(path=>path==='exchangeOrder/exchange').length;

test('native checkout reads fresh SKU/address/settlement without any order mutation',async()=>{
  const f=fixture(),context=await f.service.context(f.card.id,f.input.items),preview=await f.service.preview(f.input);
  assert.equal(context.products[0].skus[0].price,30);assert.equal(preview.deduction,60);assert.equal(preview.pieces,2);assert.equal(preview.remaining,40);assert.equal(preview.address.id,'fixture-address');assert.equal(writes(f),0);assert.equal(f.records.size,0);assert.equal(f.state.balance,100);
});
test('explicit confirmation persists intent before a single exchange and queries a paid receipt',async()=>{
  const f=fixture(),preview=await f.service.preview(f.input),result=await f.submit(preview);
  assert.equal(result.status,'succeeded');assert.equal(result.orderCode,'fixture-order');assert.equal(writes(f),1);
  assert.equal(f.state.payload.is_cart_exchange,2);assert.equal(f.state.payload.address_id,'fixture-address');
  assert.deepEqual(f.state.payload.sub_order[0].products[0],{product_code:'fixture-product',sku_code:'fixture-sku',sku_price:30,purchase_num:2,inventory_id:'fixture-pool',address_id:'fixture-address',remark:''});
  assert.ok(!('cardKey' in result));assert.equal((await f.submit(preview)).id,result.id);assert.equal(writes(f),1);
});
test('preview-only service and transport both reject final submission before acquiring a fetcher',async()=>{
  const f=fixture(true),preview=await f.service.preview(f.input);await assert.rejects(f.submit(preview),/最终下单已禁用/);assert.equal(writes(f),0);assert.equal(f.records.size,0);
  let calls=0;const client=createTradeTransport(async()=>{calls++;throw new Error('must not acquire live session');},true);
  await assert.rejects(client.exchange('synthetic',{}),/最终下单已禁用/);assert.equal(calls,0);
  await assert.rejects(client.request('synthetic','exchangeOrder/exchange',{},'POST_JSON'),/预览范围/);assert.equal(calls,0);
});
test('trade transport has a fixed mutation URL and never retries a failed write',async()=>{
  let calls=0;const client=createTradeTransport(async()=>async(url,options)=>{calls++;assert.ok(String(url).endsWith('/exchangeOrder/exchange'));assert.equal(options?.method,'POST');assert.equal(options?.credentials,'include');throw new Error('simulated lost response');});
  await assert.rejects(client.exchange('synthetic',{}),TradeTransportError);assert.equal(calls,1);
});
test('double clicks share one in-flight submit and keep the original receipt',async()=>{
  const f=fixture(),preview=await f.service.preview(f.input);let release!:()=>void;f.state.hold=new Promise(resolve=>{release=resolve;});
  const first=f.submit(preview),second=f.submit(preview);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(writes(f),1);release();
  const values=await Promise.all([first,second]);assert.equal(values[0].id,values[1].id);assert.equal(writes(f),1);
});
test('changed price, address, balance or agreement requires a new preview with no final write',async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.state.price=31;},(f:ReturnType<typeof fixture>)=>{f.state.addressPhone='13900139000';},(f:ReturnType<typeof fixture>)=>{f.state.balance=99;},(f:ReturnType<typeof fixture>)=>{f.state.agreement=true;}]){
    const f=fixture(),preview=await f.service.preview(f.input);change(f);await assert.rejects(f.submit(preview),/重新预览/);assert.equal(writes(f),0);assert.equal(f.records.size,0);
  }
});
test('expired previews, unchecked deduction and unchecked agreements cannot submit',async()=>{
  const f=fixture();f.state.agreement=true;const preview=await f.service.preview(f.input);
  await assert.rejects(f.service.submit({previewId:preview.id,digest:preview.digest,confirmDeduction:false,acceptAgreements:true}),/确认/);
  await assert.rejects(f.service.submit({previewId:preview.id,digest:preview.digest,confirmDeduction:true,acceptAgreements:false}),/商品协议/);
  f.state.clock+=120001;await assert.rejects(f.submit(preview),/过期/);assert.equal(writes(f),0);
});
test('unexpected verification, invalid delivery, unknown price and foreign SKU fail before exchange',async()=>{
  for(const mode of ['verify','delivery','price','sku']as const){const f=fixture();if(mode==='verify')f.state.needVerify=1;if(mode==='delivery')f.state.invalid=true;if(mode==='price')f.state.price=Number.NaN;if(mode==='sku')f.state.wrongSku=true;await assert.rejects(f.service.preview(f.input));assert.equal(writes(f),0);}
});
test('another card identity, source, address or renderer-supplied SKU cannot be used',async()=>{
  const a=fixture();a.state.currentNumber='222222222222';await assert.rejects(a.service.preview(a.input),/另一张卡/);assert.equal(writes(a),0);
  for(const field of ['sourceId','skuCode','addressId']as const){const f=fixture();if(field==='addressId')f.input.addressId='foreign-address';else f.input.items[0][field]='foreign';await assert.rejects(f.service.preview(f.input));assert.equal(writes(f),0);}
});
test('server settlement sum, quantity and SKU coverage are validated independently of cached prices',async()=>{
  const f=fixture(),product=normalizeTradeProduct(f.detail(),'fixture-product-id',f.offer),address=(await f.service.context(f.card.id,f.input.items)).addresses[0];
  const base:any={total_amount:60,total_pieces:2,is_need_verify:2,invalid_product_list:[],settlement_item:[{deliver_fee:0,product_list:[{spu_code:'fixture-product',sku_code:'fixture-sku',inventory_id:'fixture-pool',product_type:1,price:30,purchase_num:2,is_valid:true,stock_num:10}]}]};
  for(const mutate of [(v:any)=>{v.total_amount=1;},(v:any)=>{v.total_pieces=1;},(v:any)=>{v.settlement_item[0].product_list[0].purchase_num=1;},(v:any)=>{v.settlement_item[0].product_list.push({...v.settlement_item[0].product_list[0]});}]){const value=structuredClone(base);mutate(value);assert.throws(()=>normalizeSettlement(value,f.input.items,[product],address,''));}
});
test('insufficient current balance blocks a preview and encrypted-ledger failure blocks any mutation',async()=>{
  const f=fixture();f.state.balance=59;await assert.rejects(f.service.preview(f.input),/余额不足/);assert.equal(writes(f),0);
  const g=fixture(),preview=await g.service.preview(g.input);g.state.ledgerFailure=true;await assert.rejects(g.submit(preview),/ledger failure/);assert.equal(writes(g),0);
});
test('uncertain writes retain the journal lock across new previews and service restarts',async()=>{
  const f=fixture(),preview=await f.service.preview(f.input);f.state.failure=new TradeTransportError('synthetic timeout');const result=await f.submit(preview);
  assert.equal(result.status,'unknown');assert.equal(writes(f),1);assert.equal((await f.submit(preview)).id,result.id);assert.equal(writes(f),1);
  const other=await f.service.preview(f.input);await assert.rejects(f.submit(other),/待核对/);assert.equal(writes(f),1);
  const record=[...f.records.values()][0];record.status='submitting';f.records.set(record.id,record);
  const next=new TradeService({store:f.store,transport:f.transport,ledger:f.ledger,ensureLoggedIn:async()=>true,now:()=>f.state.clock});await next.recover();assert.equal(f.records.get(record.id)?.status,'unknown');
  const refreshed=await next.preview(f.input);await assert.rejects(next.submit({previewId:refreshed.id,digest:refreshed.digest,confirmDeduction:true,acceptAgreements:true}),/待核对/);assert.equal(writes(f),1);
});
test('explicit business rejection is recorded and an unexpected cashier is never opened',async()=>{
  const f=fixture(),preview=await f.service.preview(f.input);f.state.failure=new TradeBusinessError(1134501004,'synthetic product status changed');assert.equal((await f.submit(preview)).status,'rejected');assert.equal(writes(f),1);
  const g=fixture(),other=await g.service.preview(g.input);g.state.cashier=true;const result=await g.submit(other);assert.equal(result.status,'unknown');assert.equal(result.orderCode,'fixture-order');assert.ok(!JSON.stringify(result).includes('https://example.com'));assert.equal(writes(g),1);
});
test('an order created but not yet charged stays pending and later read-back can confirm success',async()=>{
  const f=fixture();f.state.paid=false;const preview=await f.service.preview(f.input),receipt=await f.submit(preview);assert.equal(receipt.status,'submitted');
  f.state.paid=true;f.state.balance=0;f.store.updateCard(f.card.id,{archived:true});assert.equal((await f.service.query(receipt.id)).status,'succeeded');assert.equal(writes(f),1);
});
test('trade IPC checks quantities, preview and explicit final confirmation',()=>{
  const f=fixture();validateIPC('trade-preview',[f.input]);assert.throws(()=>validateIPC('trade-context',[f.card.id,[{...f.input.items[0],quantity:100}]]));assert.throws(()=>validateIPC('trade-submit',[{previewId:'fixture',digest:'a'.repeat(64),confirmDeduction:false,acceptAgreements:true}]));assert.throws(()=>validateIPC('trade-attempts',['unexpected']));
});

test('known combination products preserve every verified component and reject forged replacements',()=>{
  const f=fixture(),offer={...f.offer,sourceId:'fixture-product:fixture-pool:2'};
  const data={...f.detail(),product_type:2,min_price:60,package_item_list:[{spu_code:'child-product',product_name:'组合子商品',item_num:2,sku_code:'child-original',sku_info:{one:{code:'child-original',name:'原规格',price:30,stock:10},two:{code:'child-replacement',name:'替换规格',price:30,stock:10}}}]};
  const product=normalizeTradeProduct(data,'fixture-product-id',offer);
  const items=[{...f.input.items[0],sourceId:offer.sourceId,skuCode:'fixture-product',quantity:1,packageReplacements:[{originalSku:'child-original',skuCode:'child-replacement'}]}];
  const address={id:'fixture-address',isDefault:true,draft:{label:'',recipient:'合成收件人',phone:'13800138000',province:'上海市',city:'上海市',district:'黄浦区',town:'',detail:'测试地址',postalCode:'',provinceId:'',cityId:'',districtId:'',townId:''}};
  const settlement={total_amount:60,total_pieces:1,is_need_verify:2,invalid_product_list:[],settlement_item:[{deliver_fee:0,product_list:[{spu_code:'fixture-product',sku_code:'fixture-product',inventory_id:'fixture-pool',product_type:2,price:60,purchase_num:1,is_valid:true,stock_num:10,settlement_item_package_item_list:[{spu_code:'child-product',sku_code:'child-replacement',price:30,item_num:2}]}]}]};
  const result=normalizeSettlement(settlement,items,[product],address,'');assert.equal((result.payload.sub_order as any[])[0].products[0].package_spu_code,'fixture-product');assert.equal((result.payload.sub_order as any[])[0].products[0].sku_code,'child-replacement');
  const wrong=structuredClone(settlement);wrong.settlement_item[0].product_list[0].settlement_item_package_item_list[0].sku_code='foreign-child';assert.throws(()=>normalizeSettlement(wrong,items,[product],address,''),/规格发生变化/);
});

test('a multi-seller order is not reported successful while a sibling remains pending',async()=>{
  const f=fixture(),request=f.transport.request;
  let sibling=1;
  f.transport.request=async(cardId,path,params,method)=>{const value=await request(cardId,path,params,method);if(path==='exchangeOrder/list'&&f.state.orderCreated)return{...value,data_list:[value.data_list[0],{...value.data_list[0],seller_order_code:'other-seller',trade_status:sibling}],total_count:2};return value;};
  const preview=await f.service.preview(f.input),receipt=await f.submit(preview);assert.equal(receipt.status,'submitted');assert.equal(writes(f),1);
  sibling=2;assert.equal((await f.service.query(receipt.id)).status,'succeeded');assert.equal(writes(f),1);
});
test('closed and partially closed merchant orders retain their actual outcome without another exchange',async()=>{
  for(const allClosed of [true,false]){
    const f=fixture(),request=f.transport.request;
    f.transport.request=async(cardId,path,params,method)=>{const value=await request(cardId,path,params,method);if(path==='exchangeOrder/list'&&f.state.orderCreated)return{...value,data_list:[{...value.data_list[0],trade_status:allClosed?6:2},{...value.data_list[0],seller_order_code:'closed-seller',trade_status:6}],total_count:2};return value;};
    const result=await f.submit(await f.service.preview(f.input));assert.equal(result.status,allClosed?'closed':'partial');assert.equal(writes(f),1);
  }
});

test('seller states spanning multiple pages are completely checked before confirming payment',async()=>{
  const f=fixture(),request=f.transport.request;let secondPaid=false;
  f.transport.request=async(cardId,path,params,method)=>{const value=await request(cardId,path,params,method);if(path==='exchangeOrder/list'&&f.state.orderCreated){const page=Number(params?.page??1);return{data_list:[{...value.data_list[0],seller_order_code:page===1?'first-seller':'second-seller',trade_status:page===1||secondPaid?2:1}],total_count:2,has_next:page===1};}return value;};
  const result=await f.submit(await f.service.preview(f.input));assert.equal(result.status,'submitted');secondPaid=true;assert.equal((await f.service.query(result.id)).status,'succeeded');assert.equal(writes(f),1);
});

test('older unresolved attempts stay visible ahead of newer completed attempts from other cards',async()=>{
  const f=fixture();f.state.paid=false;const pending=await f.submit(await f.service.preview(f.input));
  const other=f.store.addCards([{number:'222222222222',password:'synthetic-other-card-password'}]).cards[1];
  const key=createHash('sha256').update(JSON.stringify(['card',other.number])).digest('hex');
  const template=f.records.get(pending.id)!;
  for(let i=0;i<130;i++)f.records.set('completed-'+i,{...template,id:'completed-'+i,cardId:other.id,cardKey:key,status:'succeeded',startedAt:new Date(f.state.clock+1000+i).toISOString()});
  f.ledger.list=()=>structuredClone([...f.records.values()].sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)));
  const rows=f.service.attempts();assert.equal(rows[0].id,pending.id);assert.equal(rows.filter(row=>row.status==='succeeded').length,100);assert.ok(rows.some(row=>row.id===pending.id));
  f.state.paid=true;assert.equal((await f.service.query(pending.id)).status,'succeeded');assert.equal(writes(f),1);
});

test('restored order evidence remains protected until a server query confirms the result',async()=>{
  const f=fixture();f.state.failure=new TradeTransportError('synthetic response lost');
  const receipt=await f.submit(await f.service.preview(f.input)),old=f.records.get(receipt.id)!;
  const recovered={...old,updatedAt:new Date(f.state.clock+86400000).toISOString()};
  const incoming={...old,status:'succeeded' as const,orderCode:'fixture-order',sellerOrderCode:'fixture-seller-order',updatedAt:new Date(f.state.clock+1000).toISOString()};
  f.records.set(receipt.id,mergeRestoredTradeAttempt(recovered,incoming,new Date(f.state.clock+86400000).toISOString()));
  assert.equal(f.records.get(receipt.id)?.status,'submitted');
  await assert.rejects(f.submit(await f.service.preview(f.input)),/待核对/);assert.equal(writes(f),1);
  f.state.failure=null;f.state.orderCreated=true;assert.equal((await f.service.query(receipt.id)).status,'succeeded');
  assert.equal((await f.submit(await f.service.preview(f.input))).status,'succeeded');assert.equal(writes(f),2,'all exchange calls are synthetic; only the confirmed old receipt releases the protection');
});
