import type { Card,Product,CartItem } from './types';
import { unitKey } from './units';
const expiry=(value:string|null)=>value?Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value)?`${value}T23:59:59.999+08:00`:value):NaN;
export function expiryReminders(cards:Card[],days=30,now=Date.now()):{card:Card;days:number}[]{
  return cards.filter(card=>!card.archived&&card.balance!==0&&Number.isFinite(expiry(card.expiresAt))).map(card=>({card,days:Math.ceil((expiry(card.expiresAt)-now)/86400000)})).filter(item=>item.days<=days).sort((a,b)=>a.days-b.days);
}
export function budgetSummary(card:Card,items:CartItem[],products:Product[]){
  const source=items.map(item=>({item,offer:products.find(product=>product.id===item.productId)?.offers.find(offer=>offer.cardId===card.id&&offer.sourceId===item.sourceId)}));
  const units=new Set(source.flatMap(row=>row.offer?.price!==null&&row.offer?.price!==undefined?[unitKey(row.offer.priceUnit)]:[]));
  const complete=source.every(row=>row.offer?.price!==null&&row.offer?.price!==undefined)&&units.size===1;
  const total=complete?source.reduce((sum,row)=>sum+row.offer!.price!*row.item.quantity,0):null;
  const unit=units.size===1?source.find(row=>row.offer?.price!==null&&row.offer?.price!==undefined)?.offer?.priceUnit??null:null;
  const comparable=total!==null&&unit!==null&&unitKey(unit)===unitKey(card.balanceUnit)&&unitKey(card.balanceUnit)!=='selection-limit'&&card.balance!==null;
  const remaining=comparable?card.balance!-total!:null;
  const warnings:string[]=[];
  if(!complete)warnings.push('存在未知报价或不同计价单位，无法合计');
  if(source.some(row=>!row.offer||row.offer.stock===null))warnings.push('部分库存待官网确认');
  if(card.balance===null)warnings.push('余额未知，需官网确认');
  if(card.balanceUnit==='单次任选额度')warnings.push('此卡按单次上限计算，请在官网核对每次兑换');
  else if(!comparable&&total!==null)warnings.push('卡片与报价单位不同，不能扣减合计');
  return {total,unit,remaining,exceeds:remaining!==null&&remaining<0,warnings};
}
