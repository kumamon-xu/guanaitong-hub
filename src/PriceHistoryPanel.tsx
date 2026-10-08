import { useEffect,useState } from 'react';
import type { HubAPI } from './shared/types';
import type { PriceHistory } from './shared/operations';
export default function PriceHistoryPanel({api,cardId,sourceId}:{api:HubAPI;cardId:string;sourceId:string}){
  const [items,setItems]=useState<PriceHistory[]>([]),[error,setError]=useState('');
  useEffect(()=>{let active=true;setItems([]);setError('');void api.getPriceHistory(cardId,sourceId).then(rows=>{if(active)setItems(rows);}).catch(error=>{if(active)setError(error.message);});return()=>{active=false;};},[api,cardId,sourceId]);
  return <details className="price-history"><summary>当前来源报价历史（{items.length}）</summary>{error&&<p className="text-error">{error}</p>}{items.length?items.map(item=><p key={item.id}><time>{new Date(item.at).toLocaleString('zh-CN')}</time><strong>{item.price===null?'未知价格':`${item.price} ${item.unit}`}</strong></p>):<p className="muted-small">此来源还没有报价变化记录。</p>}</details>;
}
