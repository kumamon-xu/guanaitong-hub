import { app, BrowserWindow, session, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { automateLogin } from '../electron/auto-login';
import { finishHiddenLogin } from '../electron/login-window';
import { API_BASE, LOGIN_URL, unwrap } from '../electron/adapter';
import { SessionVault } from '../electron/session-vault';

// All default cases are synthetic, served only in an isolated memory session.
function fixturePage(fail:boolean,delayed=false){
  return `<!doctype html><meta charset="utf-8"><title>卡管家隐藏登录测试 · 虚构数据</title>
  <style>body{margin:20px}#challenge{position:relative;width:256px;height:128px}#challenge img{position:absolute}#piece{width:52px;height:64px;top:31px;left:0}.yidun_control{position:relative;width:256px;height:36px;margin-top:10px;background:#eee}.yidun_slider{position:absolute;left:0;top:0;width:36px;height:36px;background:#aaa}.yidun_refresh{width:50px;height:30px}</style>
  <h1>本地虚构测试，不连接官网</h1><form><input id="basic_code" value="1234567890"><input type="password" value="test-only"><div id="challenge"><img id="bg" class="yidun_bg-img"><img id="piece" class="yidun_jigsaw"></div><div class="yidun_control"><div class="yidun_slider">拖动</div></div><button type="button" class="yidun_refresh">刷新</button><label><input type="checkbox">关爱通用户协议和隐私政策</label><button id="submit" type="submit">登录 Sign in</button></form>
  <script>(${fixtureScript.toString()})(${fail},${delayed});</script>`;
}
function fixtureScript(fail:boolean,delayed:boolean){
  const w=window as any;w.metrics={releases:0,submissions:0,trusted:true,accepted:false};
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;
  const ctx=canvas.getContext('2d')!,bg=ctx.createImageData(256,128);
  let seed=782934;for(let i=0;i<bg.data.length;i+=4){for(let c=0;c<3;c++){seed=(1664525*seed+1013904223)>>>0;bg.data[i+c]=40+seed%200;}bg.data[i+3]=255;}
  const fgCanvas=document.createElement('canvas');fgCanvas.width=52;fgCanvas.height=64;
  const fgCtx=fgCanvas.getContext('2d')!,fg=fgCtx.createImageData(52,64);
  for(let y=0;y<64;y++)for(let x=0;x<52;x++){
    if(!((x>=8&&x<44&&y>=14&&y<54)||((x-26)**2+(y-14)**2<64)))continue;
    const a=4*(y*52+x),b=4*((31+y)*256+147+x);
    for(let c=0;c<3;c++){fg.data[a+c]=bg.data[b+c];bg.data[b+c]*=.55;}fg.data[a+3]=255;
  }
  ctx.putImageData(bg,0,0);fgCtx.putImageData(fg,0,0);
  (document.querySelector('#bg') as HTMLImageElement).src=canvas.toDataURL();
  const piece=document.querySelector('#piece') as HTMLImageElement;piece.src=fgCanvas.toDataURL();
  const control=document.querySelector('.yidun_control')!,slider=document.querySelector('.yidun_slider') as HTMLElement;
  let validate:HTMLInputElement|null=null;
  if(delayed){validate=document.createElement('input');validate.type='hidden';validate.name='NECaptchaValidate';document.querySelector('form')!.append(validate);}
  let start:number|null=null,offset=0;
  slider.addEventListener('mousedown',event=>{start=event.clientX;w.metrics.trusted&&=event.isTrusted;});
  document.addEventListener('mousemove',event=>{if(start==null)return;w.metrics.trusted&&=event.isTrusted;offset=Math.max(0,Math.min(204,event.clientX-start));piece.style.left=offset+'px';slider.style.left=offset+'px';});
  document.addEventListener('mouseup',event=>{
    if(start==null)return;w.metrics.trusted&&=event.isTrusted;start=null;w.metrics.releases++;
    if(!fail&&Math.abs(offset-147)<2){
      control.classList.add('yidun_control--success');
      if(delayed){
        const r=document.querySelector('#submit')!.getBoundingClientRect(),cover=document.createElement('div');
        Object.assign(cover.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',background:'#eee',zIndex:'100'});document.body.append(cover);
        setTimeout(()=>{validate!.value='synthetic-test-only';cover.remove();},700);
      }
    }
  });
  document.querySelector('.yidun_refresh')!.addEventListener('click',()=>{piece.style.left='0px';slider.style.left='0px';offset=0;});
  document.querySelector('form')!.addEventListener('submit',event=>{event.preventDefault();w.metrics.trusted&&=event.isTrusted;w.metrics.submissions++;w.metrics.accepted=(document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;w.loggedIn=w.metrics.accepted&&control.classList.contains('yidun_control--success')&&(!validate||!!validate.value);});
}
async function fixtureCase(fail:boolean,delayed=false){
  const ses=session.fromPartition(`hidden-fixture-${randomUUID()}`);
  ses.protocol.handle('https',req=>new Response(req.url===LOGIN_URL?fixturePage(fail,delayed):'',{status:req.url===LOGIN_URL?200:404,headers:{'content-type':'text/html'}}));
  const win=new BrowserWindow({show:false,width:1280,height:880,webPreferences:{session:ses,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  let shows=0,focuses=0;win.on('show',()=>shows++);win.on('focus',()=>focuses++);
  let showRequests=0;const show=win.show.bind(win);win.show=()=>{showRequests++;show();};
  try{
    await win.loadURL(LOGIN_URL);
    const startedAt=Date.now();
    const diagnostic=process.env.HUB_LOGIN_DIAGNOSTICS?{diagnostic:(data:Record<string,unknown>)=>console.log(JSON.stringify({case:'synthetic-login-diagnostic',fail,phase:data.phase,elapsedMs:Date.now()-startedAt}))}:{};
    const result=await automateLogin({window:win,session:ses,number:'1234567890',enabled:()=>true,loggedIn:()=>win.webContents.executeJavaScript('!!window.loggedIn'),progress:()=>{},...diagnostic});
    const metrics=await win.webContents.executeJavaScript('window.metrics');
    if(process.env.HUB_LOGIN_DIAGNOSTICS)console.log(JSON.stringify({case:'synthetic-login-result',fail,result,metrics,elapsedMs:Date.now()-startedAt}));
    assert.equal(win.isVisible(),false);assert.equal(showRequests,0);assert.equal(shows,0);assert.equal(focuses,0);assert.equal(win.webContents.debugger.isAttached(),false);
    assert.equal(metrics.trusted,true);assert.equal(result.ok,!fail);assert.equal(result.attempts,fail?3:1);assert.equal(metrics.releases,fail?3:1);assert.equal(metrics.submissions,fail?0:1);
    if(fail)assert.match(result.reason,/官网未通过滑块验证.*3 次/);
    let handoffs=0;
    await finishHiddenLogin({window:win,recover:async()=>result,enabled:()=>true,handOff:window=>{assert.equal(window,win);assert.equal(metrics.releases,3);handoffs++;}});
    if(fail){assert.equal(win.isVisible(),true);assert.equal(showRequests,1);assert.equal(handoffs,1);}
    else{assert.equal(win.isDestroyed(),true);assert.equal(showRequests,0);assert.equal(shows,0);assert.equal(handoffs,0);}
    console.log(JSON.stringify({case:fail?'three-failures-manual-fallback':delayed?'wait-for-token-and-uncovered-submit':'success-without-window',ok:true,attempts:result.attempts,showRequests,visible:fail,focuses,trusted:metrics.trusted,submissions:metrics.submissions}));
  }finally{if(!win.isDestroyed())win.destroy();ses.protocol.unhandle('https');}
}
async function realCase(){
  // Use one existing authorized test card, decrypting only in the Electron process.
  const folder=join(app.getPath('appData'),'guanaitong-hub','vault');
  const disk=JSON.parse(readFileSync(join(folder,'state.json'),'utf8'));
  const card=disk.state.cards.find((card:any)=>process.env.HUB_VERIFY_CARD_ID?card.id===process.env.HUB_VERIFY_CARD_ID:card.balance===200&&!card.archived);
  assert.ok(card,'未找到已授权的测试卡');
  const credential=JSON.parse(safeStorage.decryptString(Buffer.from(disk.credentials[card.id],'base64')));
  const ses=session.fromPartition(`hidden-real-${randomUUID()}`);
  const apiCalls:string[]=[];
  ses.webRequest.onBeforeRequest({urls:['https://a.guanaitong.com/card-exchange-bff/api/*']},(details,callback)=>{apiCalls.push(`${details.method} ${new URL(details.url).pathname}`);callback({});});
  ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
  const win=new BrowserWindow({show:false,width:1280,height:880,webPreferences:{session:ses,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  let shows=0,focuses=0;win.on('show',()=>shows++);win.on('focus',()=>focuses++);
  try{
    await win.loadURL(LOGIN_URL);
    await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<50;i++){
        const form=document.querySelector('form'),code=form?.querySelector('#basic_code')||form?.querySelector('input'),password=form?.querySelector('input[type="password"]');
        if(code&&password){const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [input,value] of [[code,${JSON.stringify(credential.number)}],[password,${JSON.stringify(credential.password)}]]){setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}return;}
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      throw new Error('官网表单未加载');
    })()`);
    const loggedIn=async()=>{
      try{
        const response=await ses.fetch(API_BASE+'common/getCurrentInfo',{credentials:'include',redirect:'error',signal:AbortSignal.timeout(25000),headers:{Accept:'application/json',platform:'browser',channel:'common','Client-Type':'2',version:'1.0.0','Ecapp-Code':'card_exchange',Referer:LOGIN_URL,Origin:'https://a.guanaitong.com'}});
        const body=await response.json();
        const data=unwrap(body);const matched=String(data.card_code)===credential.number;
        if(!matched)console.log(JSON.stringify({phase:'not-logged-in',code:body.code,message:String(body.message??body.msg??'').slice(0,200)}));
        return matched;
      }catch{return false;}
    };
    const result=await automateLogin({window:win,session:ses,number:credential.number,enabled:()=>true,loggedIn,progress:message=>console.log(message),diagnostic:metadata=>console.log(JSON.stringify(metadata))});
    if(!result.ok){
      const page=await win.webContents.executeJavaScript(`({path:location.pathname,title:document.title,messages:Array.from(document.querySelectorAll('.ant-message-notice-content,.ant-form-item-explain-error,.ant-notification-notice-message,.ant-notification-notice-description,.ant-modal-title,.ant-modal-body')).map(node=>node.textContent?.slice(0,250)).slice(0,8)})`);
      console.log(JSON.stringify({phase:'login-failed-page',...page,apiCalls}));
    }
    assert.equal(result.ok,true,result.reason);assert.equal(await loggedIn(),true);assert.equal(shows,0);assert.equal(focuses,0);assert.equal(win.isVisible(),false);assert.equal(win.webContents.debugger.isAttached(),false);
    // Retain this genuinely authenticated session for the next normal app launch.
    const vault=new SessionVault({directory:folder,encryptString:value=>safeStorage.encryptString(value),decryptString:value=>safeStorage.decryptString(value)});
    await vault.save(card.id,()=>ses.cookies.get({domain:'guanaitong.com'}));await vault.flush();
    console.log(JSON.stringify({case:'real-official-hidden-login',ok:true,attempts:result.attempts,shows,focuses,cardIdentityVerified:true,sessionSaved:true}));
  }finally{win.destroy();}
}
app.setName('guanaitong-hub');
if(process.env.HUB_VERIFY_APP_DATA){mkdirSync(process.env.HUB_VERIFY_APP_DATA,{recursive:true});app.setPath('userData',process.env.HUB_VERIFY_APP_DATA);}
// Closing a successful hidden renderer must not end the multi-case test process.
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  try{
    if(process.env.HUB_VERIFY_REAL_LOGIN==='1')await realCase();
    else{await fixtureCase(false);await fixtureCase(false,true);await fixtureCase(true);}
    app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
