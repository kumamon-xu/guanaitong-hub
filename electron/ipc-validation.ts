import { validateProductQuery, validateOrderQuery } from '../src/shared/queries';
import type { ProductQuery, OrderQuery } from '../src/shared/operations';

function string(value:unknown,optional=false,max=200):void{if(optional&&value===undefined)return;if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('操作参数无效');}
function object(value:unknown):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('操作参数须为对象');}
function integer(value:unknown,min:number,max:number):void{if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new Error('操作数量无效');}
export function validateIPC(name:string,args:unknown[]):void{
  const counts:Record<string,[number,number]>={state:[0,0],'view-state':[0,0],addresses:[0,0],diagnostics:[0,0],'data-folder':[0,0],'query-products':[1,1],product:[1,1],'query-orders':[1,1],'export-orders':[1,1],'sync-tasks':[0,0],'cancel-sync':[0,1],'retry-sync':[0,0],'price-history':[2,2],'check-updates':[0,0],'open-update':[0,0],'save-address':[1,2],'default-address':[1,1],'remove-address':[1,1],'export-addresses':[1,1],'import-addresses':[1,1],'address-regions':[0,1],'official-addresses':[1,1],'publish-address':[3,3],'add-cards':[1,1],'update-card':[2,2],settings:[1,1],favorite:[1,1],merge:[1,1],'add-cart':[3,4],'update-cart':[2,2],'open-card':[1,2],'open-product':[2,3],'sync-card':[1,1],checkout:[1,1],'sync-all':[0,0],export:[1,1],import:[1,1]};
  const count=counts[name];if(!count||args.length<count[0]||args.length>count[1])throw new Error('IPC 参数数量无效');
  if(['query-products'].includes(name))validateProductQuery(args[0] as ProductQuery);
  else if(['query-orders','export-orders'].includes(name))validateOrderQuery(args[0] as OrderQuery);
  else if(['product','default-address','remove-address','official-addresses','favorite','sync-card','checkout'].includes(name))string(args[0]);
  else if(name==='cancel-sync'||name==='address-regions')string(args[0],true);
  else if(['export','import','export-addresses','import-addresses'].includes(name)){string(args[0],false,1024);if((args[0] as string).length<8)throw new Error('备份口令至少 8 个字符');}
  else if(name==='save-address'){object(args[0]);string(args[1],true);}
  else if(name==='publish-address'){string(args[0]);string(args[1]);if(typeof args[2]!=='boolean')throw new Error('默认地址选项无效');}
  else if(name==='update-card'){string(args[0]);object(args[1]);if(Object.keys(args[1]).some(key=>!['label','note','archived','tags'].includes(key)))throw new Error('不支持的卡片修改字段');}
  else if(name==='settings'){object(args[0]);if(Object.keys(args[0]).some(key=>!['autoArchive','maskNumbers','autoLogin','syncConcurrency','expiryReminderDays','updateFeed'].includes(key)))throw new Error('不支持的设置字段');}
  else if(name==='add-cards'){if(!Array.isArray(args[0])||args[0].length<1||args[0].length>1000)throw new Error('卡片数量无效');for(const item of args[0])object(item);}
  else if(name==='merge'){if(!Array.isArray(args[0])||args[0].length<2||args[0].length>1000)throw new Error('合并商品数量无效');for(const id of args[0])string(id);}
  else if(name==='add-cart'){string(args[0]);string(args[1]);integer(args[2],1,99);string(args[3],true,500);}
  else if(name==='update-cart'){string(args[0]);integer(args[1],0,99);}
  else if(name==='open-card'){string(args[0]);if(args[1]!==undefined&&!['login','shop','orders','addresses'].includes(String(args[1])))throw new Error('官网操作类型无效');}
  else if(name==='open-product'){string(args[0]);string(args[1]);string(args[2],true,500);}
  else if(name==='price-history'){string(args[0]);string(args[1],false,500);}
}
