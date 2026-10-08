import type { AppState,HubAPI } from './shared/types';
import { expiryReminders } from './shared/management';
export default function ManagementPanel({state,api,onState,onMessage}:{state:AppState;api:HubAPI;onState:(state:AppState)=>void;onMessage:(text:string,error?:boolean)=>void}){
  const reminders=expiryReminders(state.cards,state.settings.expiryReminderDays??30);
  return <section className="management-panel"><div className="section-heading"><h2>到期提醒</h2><label>提前 <select aria-label="到期提醒天数" value={state.settings.expiryReminderDays??30} onChange={event=>void api.updateSettings({expiryReminderDays:Number(event.target.value)}).then(onState).catch(error=>onMessage(error.message,true))}>{[7,14,30,60,90].map(days=><option key={days} value={days}>{days} 天</option>)}</select></label></div>{reminders.length?reminders.map(({card,days})=><p key={card.id}><strong>{card.label} · 尾号 {card.number.slice(-4)}</strong><span className={days<=7?'text-error':''}>{days<0?'已到期':days===0?'今天到期':`${days} 天内到期`} · {card.expiresAt?new Date(card.expiresAt).toLocaleDateString('zh-CN'):''}</span></p>):<p className="muted-small">提醒范围内没有待使用的到期卡片。</p>}</section>;
}
