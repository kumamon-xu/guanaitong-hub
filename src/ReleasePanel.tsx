import { useState } from 'react';
import type { HubAPI,AppState } from './shared/types';
import type { UpdateInfo } from './shared/operations';
export default function ReleasePanel({api,state,onState,onMessage}:{api:HubAPI;state:AppState;onState:(state:AppState)=>void;onMessage:(text:string,error?:boolean)=>void}){
  const [feed,setFeed]=useState(state.settings.updateFeed??''),[info,setInfo]=useState<UpdateInfo|null>(null),[busy,setBusy]=useState(false);
  const check=async()=>{setBusy(true);setInfo(null);try{onState(await api.updateSettings({updateFeed:feed.trim()}));setInfo(await api.checkUpdates());}catch(error){onMessage(error instanceof Error?error.message:String(error),true);}finally{setBusy(false);}};
  return <section className="settings-panel release-panel"><h2>程序更新</h2><p>填写维护者提供的发布清单地址，查看版本和发布说明。</p><label className="form-field">发布清单地址<input type="url" value={feed} placeholder="https://…/release.json" onChange={event=>setFeed(event.target.value)}/></label><button className="button secondary" disabled={busy||!feed.trim()} onClick={()=>void check()}>{busy?'正在检查…':'检查更新'}</button>{info&&<div className="release-result"><strong>{info.available?`可更新至 v${info.version}`:`当前版本 v${info.currentVersion} 已是最新`}</strong><p className="release-notes">{info.notes}</p>{info.available&&<button className="button primary" disabled={busy} onClick={()=>{setBusy(true);void api.openUpdate().then(()=>onMessage('当前数据库已备份，安装包页面已打开')).catch(error=>onMessage(error.message,true)).finally(()=>setBusy(false));}}>备份数据并打开下载</button>}</div>}</section>;
}
