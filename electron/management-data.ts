import type { ManagementData, PriceHistory, SyncTask } from '../src/shared/operations';
import { validateTradeAttempts } from './trade-records';

export function validateManagement(value:unknown,cards:Set<string>):ManagementData{
  const data=value as ManagementData;
  if(!data||!Array.isArray(data.priceHistory)||!Array.isArray(data.syncTasks)||data.priceHistory.length>200000||data.syncTasks.length>1000)throw new Error('管理记录格式或数量无效');
  function text(value:unknown,max=200):asserts value is string{if(typeof value!=='string'||!value||value.length>max)throw new Error('管理记录文字无效');}
  function date(value:unknown):asserts value is string{text(value);if(!Number.isFinite(Date.parse(value)))throw new Error('管理记录日期无效');}
  const historyIds=new Set<string>(),taskIds=new Set<string>();
  const priceHistory=data.priceHistory.map(item=>{
    text(item.id);text(item.cardId);text(item.sourceId,500);date(item.at);
    if(!cards.has(item.cardId)||historyIds.has(item.id)||typeof item.unit!=='string'||item.unit.length>4000||(item.price!==null&&(typeof item.price!=='number'||!Number.isFinite(item.price)||item.price<0)))throw new Error('报价历史关联或数值无效');
    historyIds.add(item.id);
    return {id:item.id,cardId:item.cardId,sourceId:item.sourceId,at:item.at,price:item.price,unit:item.unit} satisfies PriceHistory;
  });
  const syncTasks=data.syncTasks.map(item=>{
    text(item.id);text(item.batchId);text(item.cardId);date(item.startedAt);if(item.finishedAt!==null)date(item.finishedAt);
    if(!cards.has(item.cardId)||taskIds.has(item.id)||!['queued','running','succeeded','failed','cancelled','interrupted'].includes(item.status)||!['queued','identity','products','orders','categories','commit','complete'].includes(item.phase)||typeof item.message!=='string'||item.message.length>4000||!Number.isInteger(item.page)||item.page<0||!Number.isInteger(item.completed)||item.completed<0||(item.total!==null&&(!Number.isInteger(item.total)||item.total<0))||(item.errorKind!==null&&!['login','network','timeout','http','schema','identity','storage','cancelled','unknown'].includes(item.errorKind)))throw new Error('同步任务记录无效');
    taskIds.add(item.id);
    if(item.endpoint!==undefined)text(item.endpoint);
    return {id:item.id,batchId:item.batchId,cardId:item.cardId,status:item.status,phase:item.phase,page:item.page,completed:item.completed,total:item.total,message:item.message,errorKind:item.errorKind,startedAt:item.startedAt,finishedAt:item.finishedAt,...(item.endpoint?{endpoint:item.endpoint}:{})} satisfies SyncTask;
  });
  return {priceHistory,syncTasks,...(data.tradeAttempts!==undefined?{tradeAttempts:validateTradeAttempts(data.tradeAttempts)}:{})};
}
