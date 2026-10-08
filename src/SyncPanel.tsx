import { useEffect,useState } from 'react';
import type { HubAPI,Card } from './shared/types';
import type { SyncTask } from './shared/operations';
const phases={queued:'排队',identity:'核对卡号',products:'读取商品',orders:'读取订单',categories:'读取分类',commit:'保存数据',complete:'完成'};
const errors={login:'登录失效',network:'网络异常',timeout:'超时',http:'接口错误',schema:'响应结构变化',identity:'卡号不一致',storage:'保存失败',cancelled:'已取消',unknown:'其他异常'};
const statuses={queued:'等待',running:'进行中',succeeded:'成功',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
export default function SyncPanel({api,cards,onMessage}:{api:HubAPI;cards:Card[];onMessage:(message:string,error?:boolean)=>void}){
  const [tasks,setTasks]=useState<SyncTask[]>([]);
  useEffect(()=>{let active=true;void api.getSyncTasks().then(value=>{if(active)setTasks(value);}).catch(error=>onMessage(error.message,true));const off=api.onSyncTasks(setTasks);return()=>{active=false;off();};},[api]);
  const latest=[...new Map([...tasks].reverse().map(task=>[task.cardId,task])).values()].reverse();
  const running=tasks.some(task=>['running','queued'].includes(task.status));
  const action=(fn:()=>Promise<unknown>)=>void fn().catch(error=>onMessage(error.message,true));
  if(!tasks.length)return null;
  return <section className="sync-monitor"><div className="section-heading"><h2>同步任务</h2><div className="heading-actions"><button className="button secondary small" disabled={!running} onClick={()=>action(()=>api.cancelSync())}>取消全部</button><button className="button secondary small" disabled={running} onClick={()=>action(()=>api.retryFailedSync())}>重试失败项</button></div></div>{latest.map(task=><div className="sync-task" key={task.id}><div><strong>{cards.find(card=>card.id===task.cardId)?.label||'福利卡'}</strong><span>{statuses[task.status]} · {phases[task.phase]}{task.page?` · 第 ${task.page} 页`:''}{task.completed?` · ${task.completed}${task.total===null?'':` / ${task.total}`} 条`:''}</span>{task.total!==null&&task.total>0&&<progress max={task.total} value={Math.min(task.completed,task.total)}/>}<p className={task.status==='failed'?'text-error':'muted-small'}>{task.message}{task.errorKind?`（${errors[task.errorKind]}）`:''}</p></div><button className="button secondary small" disabled={!['running','queued'].includes(task.status)} onClick={()=>action(()=>api.cancelSync(task.cardId))}>取消此卡</button></div>)}<details><summary>最近 {tasks.length} 个任务 · 批次记录</summary>{tasks.slice(0,20).map(task=><p key={task.id} className="muted-small">{task.batchId.slice(0,8)} · {cards.find(card=>card.id===task.cardId)?.label} · {statuses[task.status]} · {new Date(task.startedAt).toLocaleString('zh-CN')}</p>)}</details></section>;
}
