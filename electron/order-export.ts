import type { Card,Order } from '../src/shared/types';
import { maskCardNumber,redactText } from './redaction';
const cell=(value:unknown)=>{
  const text=String(value??'');const safe=/^[\s]*[=+\-@]/.test(text)?"'"+text:text;
  return '"'+safe.replace(/"/g,'""')+'"';
};
export function exportOrderCSV(orders:Order[],cards:Card[]):string{
  const byId=new Map(cards.map(card=>[card.id,card]));
  const rows:unknown[][]=[['来源卡号（脱敏）','订单号','商品','状态','金额','下单时间','物流单号']];
  for(const order of orders)rows.push([maskCardNumber(byId.get(order.cardId)?.number??''),redactText(order.sourceId),redactText(order.name),redactText(order.status),order.amount??'未知',order.createdAt,redactText(order.tracking)]);
  return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
