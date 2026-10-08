import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchSnapshot,normalizeCard,normalizeProducts,normalizeOrders,officialURL,unwrap,LoginRequired} from '../electron/adapter';
import type {Card} from '../src/shared/types';
const card:Card={id:'c1',number:'100000000001',label:'Test',balance:null,balanceUnit:'额度',status:'pending',expiresAt:null,syncedAt:null,addedAt:'',archived:false,note:'',error:null,productCount:0,hasPassword:true};
test('unknown balance is not exhausted and identity mismatch is rejected',()=>{
  assert.equal(normalizeCard({card_code:card.number,balance:null,is_usable:1},card).balance,null);
  assert.equal(normalizeCard({card_code:card.number,balance:0,is_usable:1},card).status,'exhausted');
  assert.throws(()=>normalizeCard({card_code:'other',balance:50},card),/另一张卡/);
  assert.throws(()=>unwrap({code:1134301002}),LoginRequired);
  for(const malformed of [false,[],{},true])assert.equal(normalizeCard({card_code:card.number,balance:malformed,is_usable:1},card).balance,null);
});
test('source inventory and multi-SKU ambiguity survive normalization',()=>{
  const p=normalizeProducts([{product_code:'P',inventory_id:20,product_title:'商品',price:50,max_price:100,is_sold_out:2,product_head_pic_url:'https://evil.example/x.png'}],card,{});
  assert.equal(p[0].mergeKey,'');assert.equal(p[0].offers[0].stock,null);assert.equal(p[0].image,'');
  assert.equal(new URL(p[0].offers[0].url).searchParams.get('inventory_id'),'20');
  assert.equal(officialURL('https://guanaitong.com.evil.example/'),false);
});
test('full snapshot verifies pagination and identity, not partial success',async()=>{
  let pages:number[]=[];
  const snapshot=await fetchSnapshot(async(path,params)=>{
    if(path==='common/getCurrentInfo')return{code:0,data:{card_code:card.number,balance:100,is_usable:1}};
    if(path==='exchangeOrder/list')return{code:0,data:{data_list:[],total_count:0,has_next:false}};
    pages.push(Number(params?.page)); const page=Number(params?.page);
    return{code:0,data:{total_count:2,has_next:page===1,data_list:[{product_code:'P'+page,inventory_id:1,product_title:'商品'+page,price:50,max_price:50}]}};
  },card);
  assert.deepEqual(pages,[1,2]);assert.equal(snapshot.products.length,2);
  await assert.rejects(fetchSnapshot(async(path)=>path==='common/getCurrentInfo'?{code:0,data:{card_code:card.number,balance:100,is_usable:1}}:{code:0,data:{total_count:2,data_list:[],has_next:false}},card),/不完整/);
});
test('seller order identities stay distinct and detail links retain official main order code',()=>{
  const orders=normalizeOrders([{shop_order_code:'main',seller_order_code:'seller1',trade_status:3,time_order_payed:123},{shop_order_code:'main',seller_order_code:'seller2',trade_status:3}],card);
  assert.notEqual(orders[0].sourceId,orders[1].sourceId);assert.notEqual(orders[0].id,orders[1].id);
  assert.equal(new URL(orders[0].url).pathname,'/festival-exchange-pc/order/detail');
  assert.equal(new URL(orders[0].url).searchParams.get('shop_order_code'),'main');
  assert.equal(orders[0].status,'已兑换');assert.equal(orders[1].status,'已关闭');
});
