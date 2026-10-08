import type { AppState, Product, ProductOffer } from './types';
import type { ProductQuery, ProductPage, OrderQuery, OrderPage } from './operations';
import { resolvePriceFilter, sortProductsByPrice, priceFilterUnits, priceFilterAmounts } from './price-filter';

export const categoryName=(name:string)=>({'3C数码':'数码3C','母婴玩具宠物':'母婴玩具·宠物','母婴玩具':'母婴玩具·宠物'}[name]??name);
export function sourceCategories(product:Product,offer:ProductOffer):string[]{
  return (offer.categories?.length?offer.categories:product.offers.length===1?(product.categories?.length?product.categories:[product.category]):['未分类']).filter(Boolean).map(categoryName);
}
function text(value:unknown,max=500):asserts value is string{if(typeof value!=='string'||value.length>max)throw new Error('查询文字无效');}
export function validateProductQuery(value:ProductQuery):ProductQuery{
  validatePagination(value);text(value.cardId,200);text(value.search);text(value.category,200);
  if(typeof value.favoritesOnly!=='boolean'||!value.price||!Array.isArray(value.price.amounts)||value.price.amounts.length>2000||typeof value.price.unit!=='string'||!['default','ascending','descending'].includes(value.price.sort))throw new Error('商品筛选无效');
  text(value.price.unit,4000);
  const filter=resolvePriceFilter(value.price);if(filter.error)throw new Error(filter.error);
  return structuredClone(value);
}
export function validateOrderQuery(value:OrderQuery):OrderQuery{
  validatePagination(value);text(value.cardId,200);text(value.search);text(value.status,200);
  for(const field of ['from','to'] as const){text(value[field],10);if(value[field]&&!/^\d{4}-\d{2}-\d{2}$/.test(value[field]))throw new Error('订单日期无效');if(value[field]){const parsed=new Date(`${value[field]}T00:00:00Z`);if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value[field])throw new Error('订单日期无效');}}
  if(value.from&&value.to&&value.from>value.to)throw new Error('开始日期须早于结束日期');
  return structuredClone(value);
}
function validatePagination(value:{page:number;pageSize:number}):void{
  if(!value||!Number.isInteger(value.page)||value.page<1||value.page>100000||!Number.isInteger(value.pageSize)||value.pageSize<1||value.pageSize>100)throw new Error('分页参数无效');
}
export function queryProductsInMemory(state:AppState,query:ProductQuery):ProductPage{
  const q=validateProductQuery(query);
  const available=(offer:ProductOffer)=>{const card=state.cards.find(item=>item.id===offer.cardId);return !!card&&!card.archived&&!['expired','exhausted'].includes(card.status)&&offer.stock!==0;};
  const matches=(offer:ProductOffer)=>{const product=state.products.find(item=>item.offers.includes(offer));return !!product&&(q.category==='全部分类'||sourceCategories(product,offer).includes(q.category));};
  const base=sortProductsByPrice(state.products,q.cardId,q.price,available);
  const allNames=[...new Set(state.products.flatMap(product=>product.offers.flatMap(offer=>sourceCategories(product,offer))))];
  const counts=allNames.map(name=>({name,count:sortProductsByPrice(state.products,q.cardId,q.price,available,offer=>{const product=state.products.find(item=>item.offers.includes(offer));return !!product&&sourceCategories(product,offer).includes(name);}).length}));
  const rows=sortProductsByPrice(state.products,q.cardId,q.price,available,matches).filter(item=>(!q.favoritesOnly||item.favorite)&&`${item.name} ${item.brand} ${item.specification}`.toLowerCase().includes(q.search.trim().toLowerCase()));
  return {items:structuredClone(rows.slice((q.page-1)*q.pageSize,q.page*q.pageSize)),total:rows.length,page:q.page,pageSize:q.pageSize,categories:[{name:'全部分类',count:base.length},...counts],units:priceFilterUnits(state.products,q.cardId),amounts:priceFilterAmounts(state.products,q.cardId,q.price.unit)};
}
export function queryOrdersInMemory(state:AppState,query:OrderQuery):OrderPage{
  const q=validateOrderQuery(query);
  const rows=state.orders.filter(item=>(q.cardId==='all'||item.cardId===q.cardId)&&(q.status==='all'||item.status===q.status)&&`${item.name} ${item.sourceId} ${item.tracking}`.toLowerCase().includes(q.search.trim().toLowerCase())&&(!q.from||(item.createdAt&&Date.parse(item.createdAt)>=Date.parse(`${q.from}T00:00:00+08:00`)))&&(!q.to||(item.createdAt&&Date.parse(item.createdAt)<=Date.parse(`${q.to}T23:59:59.999+08:00`)))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
  return {items:structuredClone(rows.slice((q.page-1)*q.pageSize,q.page*q.pageSize)),total:rows.length,page:q.page,pageSize:q.pageSize,statuses:[...new Set(state.orders.map(item=>item.status))]};
}
