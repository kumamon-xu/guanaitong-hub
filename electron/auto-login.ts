import type { BrowserWindow, Session } from 'electron';
import { matchSlider, type PixelImage } from './slider-match';
import { createLoginInput } from './login-input';

interface Rect { x:number;y:number;width:number;height:number; }
interface ChallengeImage { src:string;rect:Rect;width:number;height:number; }
interface LoginPage {
  ready:boolean;verified:boolean;validationReady:boolean;submitReady:boolean;accountMatches:boolean;message:string;
  widgetClasses?:string[];
  background:ChallengeImage|null;piece:ChallengeImage|null;
  slider:Rect|null;reveal:Rect|null;refresh:Rect|null;submit:Rect|null;
}
export interface LoginResult { ok:boolean;attempts:number;reason:string; }
interface LoginOptions {
  window:BrowserWindow;session:Session;number:string;
  enabled:()=>boolean;loggedIn:()=>Promise<boolean>;
  progress:(message:string)=>void;
  diagnostic?:(metadata:Record<string,unknown>)=>void;
}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** Read only the known login controls, never serialize password fields or tokens. */
function inspectLogin(number:string):LoginPage {
  const empty:LoginPage={ready:false,verified:false,validationReady:false,submitReady:false,accountMatches:false,message:'',background:null,piece:null,slider:null,reveal:null,refresh:null,submit:null};
  if(location.origin!=='https://a.guanaitong.com'||location.pathname!=='/festival-exchange-pc/login')return empty;
  const visible=(node:Element|null):node is HTMLElement=>!!node&&node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0&&getComputedStyle(node).visibility!=='hidden';
  const find=(selector:string)=>Array.from(document.querySelectorAll(selector)).find(visible) as HTMLElement|undefined;
  const rect=(node:Element|undefined):Rect|null=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
  const image=(node:HTMLElement|undefined):ChallengeImage|null=>{if(!(node instanceof HTMLImageElement)||!node.complete||!node.naturalWidth)return null;return{src:node.currentSrc||node.src,rect:rect(node)!,width:node.naturalWidth,height:node.naturalHeight};};
  const form=document.querySelector('form');
  const code=form?.querySelector<HTMLInputElement>('#basic_code,input:not([type="password"]):not([type="checkbox"])');
  const password=form?.querySelector<HTMLInputElement>('input[type="password"]');
  const submit=Array.from(form?.querySelectorAll('button')??[]).find(button=>/登录\s*Sign\s*in/i.test(button.textContent??'')&&!button.disabled);
  const control=find('.yidun_control');
  const widgetClasses=Array.from(document.querySelectorAll('[class*="yidun"]')).filter(visible).map(node=>String(node.className)).slice(0,45);
  const validate=form?.querySelector<HTMLInputElement>('input[name="NECaptchaValidate"],input[name="yi_dun_validate"],#basic_yi_dun_validate');
  const text=Array.from(document.querySelectorAll('.ant-message-notice-content,.ant-form-item-explain-error,.ant-notification-notice-message,.ant-notification-notice-description,.yidun_tips__text,.yidun_tips')).map(node=>node.textContent??'').join(' ').replace(/\s+/g,' ').trim().slice(0,300);
  const verified=/验证成功/.test(control?.textContent??'')||!!find('.yidun--success,.yidun_control--success,.yidun_slider--success')||!!validate?.value;
  const submitRect=rect(submit),hit=submitRect?document.elementFromPoint(submitRect.x+submitRect.width/2,submitRect.y+submitRect.height/2):null;
  return{ready:!!code&&!!password?.value&&!!submit,accountMatches:code?.value===number,verified,validationReady:verified&&(!(validate instanceof HTMLInputElement)||!!validate.value),submitReady:!!submit&&!!hit&&(hit===submit||submit.contains(hit)),widgetClasses,
    message:text,background:image(find('img.yidun_bg-img,img[alt="验证码背景"]')),piece:image(find('img.yidun_jigsaw,img[alt="验证码滑块"]')),
    slider:rect(find('.yidun_slider')),reveal:rect(control),refresh:rect(find('.yidun_refresh')),submit:rect(submit)};
}
function acceptExistingAgreement(number:string):boolean {
  if(location.origin!=='https://a.guanaitong.com'||location.pathname!=='/festival-exchange-pc/login')return false;
  const form=document.querySelector('form');
  const code=form?.querySelector<HTMLInputElement>('#basic_code,input:not([type="password"]):not([type="checkbox"])');
  if(code?.value!==number)return false;
  const checkbox=form?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if(!checkbox||!form?.textContent?.includes('关爱通用户协议')||!form.textContent.includes('隐私政策'))return false;
  if(!checkbox.checked)checkbox.click();return checkbox.checked;
}
async function decodeChallenge(bgData:string,pieceData:string,bgWidth:number,bgHeight:number,pieceWidth:number,pieceHeight:number):Promise<{background:PixelImage;piece:PixelImage}> {
  const load=(src:string,width:number,height:number)=>new Promise<PixelImage>((resolve,reject)=>{
    const image=new Image();const timeout=setTimeout(()=>reject(new Error('图像解码超时')),5000);
    image.onerror=()=>{clearTimeout(timeout);reject(new Error('图像解码失败'));};
    image.onload=()=>{clearTimeout(timeout);try{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0,width,height);resolve({width,height,data:Array.from(ctx.getImageData(0,0,width,height).data)});}catch{reject(new Error('图像不可读取'));}};
    image.src=src;
  });
  const [background,piece]=await Promise.all([load(bgData,bgWidth,bgHeight),load(pieceData,pieceWidth,pieceHeight)]);return{background,piece};
}
export function allowedChallengeImage(url:string):boolean {
  try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/^(?:[a-z0-9-]+\.)*(?:nosdn\.127\.net|nosdn\.126\.net|nos-eastchina1\.126\.net)$/.test(u.hostname);}catch{return false;}
}
async function imageData(session:Session,url:string):Promise<string>{
  if(/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(url)&&url.length<3_000_000)return url;
  if(!allowedChallengeImage(url))throw new Error('验证码图片来源暂不支持，请手动完成验证。');
  // CAPTCHA image requests never include the card's authentication cookies.
  const response=await session.fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10_000)});
  const mime=response.headers.get('content-type')?.split(';')[0];
  if(!response.ok||!mime||!['image/png','image/jpeg','image/webp'].includes(mime)||Number(response.headers.get('content-length'))>2_000_000)throw new Error('验证码图片读取失败。');
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>2_000_000)throw new Error('验证码图片过大。');
  return`data:${mime};base64,${bytes.toString('base64')}`;
}
export async function automateLogin(options:LoginOptions):Promise<LoginResult>{
  const {window:win,number}=options;let attempts=0;const deadline=Date.now()+60_000;
  let challengeFailure='滑块验证未通过';
  let input:ReturnType<typeof createLoginInput>|undefined;
  const alive=()=>!win.isDestroyed()&&!win.webContents.isDestroyed()&&options.enabled()&&Date.now()<deadline;
  const inspect=async()=>{
    if(!alive())throw new Error('自动登录已停止。');
    return await win.webContents.executeJavaScript(`(${inspectLogin.toString()})(${JSON.stringify(number)})`) as LoginPage;
  };
  const click=async(rect:Rect)=>{
    if(!alive())throw new Error('自动登录已停止。');
    const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
    await input!.send({type:'mouseMove',x,y});
    await input!.send({type:'mouseDown',x,y,button:'left',clickCount:1});
    await delay(65);if(win.isDestroyed()||win.webContents.isDestroyed())return;
    await input!.send({type:'mouseUp',x,y,button:'left',clickCount:1});
  };
  try{
    input=createLoginInput(win.webContents);
    let state=await inspect();const widgetDeadline=Date.now()+20_000;
    while(alive()&&Date.now()<widgetDeadline&&(!state.ready||(!state.reveal&&!state.verified))){await delay(200);state=await inspect();}
    if(!state.ready||!state.accountMatches)throw new Error('官网表单尚未准备好，或卡号不匹配。');
    options.diagnostic?.({phase:'ready',slider:!!state.slider,reveal:!!state.reveal});
    for(let attempt=1;attempt<=3&&alive()&&!state.verified;attempt++){
      attempts=attempt;
      options.progress(`正在本地识别官网滑块（第 ${attempts}/3 次）。`);
      if(!state.background||!state.piece){
        if(!state.reveal)throw new Error('当前验证码类型暂不支持，请在官网完成验证。');
        await click(state.reveal);
        for(let i=0;i<35&&alive();i++){await delay(200);state=await inspect();if(state.verified||(state.background&&state.piece))break;}
      }
      if(state.verified)break;
      // Popup animation and asynchronous refresh can leave old image geometry briefly visible.
      for(let i=0;i<20&&alive();i++){
        const previous=state;await delay(100);state=await inspect();
        if(state.verified)break;
        const stable=(a:ChallengeImage|null,b:ChallengeImage|null)=>!!a&&!!b&&a.src===b.src&&Math.abs(a.rect.x-b.rect.x)<.5&&Math.abs(a.rect.y-b.rect.y)<.5&&Math.abs(a.rect.width-b.rect.width)<.5&&Math.abs(a.rect.height-b.rect.height)<.5;
        if(stable(previous.background,state.background)&&stable(previous.piece,state.piece)&&state.slider)break;
      }
      if(state.verified)break;
      const {background,piece,slider}=state;
      if(!background||!piece||!slider)throw new Error('官网验证码尚未加载，或已更换为其他验证方式。');
      const scale=background.width/background.rect.width;
      const pw=Math.round(piece.rect.width*scale),ph=Math.round(piece.rect.height*scale);
      if(background.width>1024||background.height>512||pw<8||ph<8)throw new Error('当前验证码图像规格暂不支持。');
      options.diagnostic?.({phase:'images',hosts:[new URL(background.src).hostname,new URL(piece.src).hostname],background:{width:background.width,height:background.height,rect:background.rect},piece:{width:piece.width,height:piece.height,rect:piece.rect},slider});
      const [bgData,pieceData]=await Promise.all([imageData(options.session,background.src),imageData(options.session,piece.src)]);
      const pixels=await win.webContents.executeJavaScript(`(${decodeChallenge.toString()})(${JSON.stringify(bgData)},${JSON.stringify(pieceData)},${background.width},${background.height},${pw},${ph})`) as{background:PixelImage;piece:PixelImage};
      const top=Math.round((piece.rect.y-background.rect.y)*scale);
      const match=matchSlider(pixels.background,pixels.piece,top,Math.max(12,pw/2));
      options.diagnostic?.({phase:'match',match,top,scale});
      if(match){
        const fresh=await inspect();
        if(fresh.background?.src!==background.src||fresh.piece?.src!==piece.src||!fresh.slider||Math.abs(fresh.background.rect.x-background.rect.x)>1||Math.abs(fresh.background.rect.y-background.rect.y)>1||Math.abs(fresh.background.rect.width-background.rect.width)>1||Math.abs(fresh.piece.rect.x-piece.rect.x)>1||Math.abs(fresh.piece.rect.y-piece.rect.y)>1||Math.abs(fresh.slider.x-slider.x)>1||Math.abs(fresh.slider.y-slider.y)>1){challengeFailure='验证码刷新或位置变化';state=fresh;continue;}
        const target=background.rect.x+match.x/scale;
        const distance=target-piece.rect.x;
        if(distance<8||distance>background.rect.width)throw new Error('验证码匹配距离无效。');
        const start={x:Math.round(slider.x+slider.width/2),y:Math.round(slider.y+slider.height/2)};
        let x=start.x;
        await input.send({type:'mouseMove',...start});
        await input.send({type:'mouseDown',...start,button:'left',clickCount:1});
        try{
          const steps=Math.max(24,Math.ceil(distance/4));
          for(let step=1;step<=steps&&alive();step++){
            const t=step/steps;x=Math.round(start.x+distance*(3*t*t-2*t*t*t));
            await input.send({type:'mouseMove',x,y:start.y,button:'left',modifiers:['leftbuttondown']});await delay(18);
          }
          if(alive()){
            // Read the actual puzzle position to account for the widget's drag scale.
            for(let correction=0;correction<2;correction++){
              const during=await inspect();if(during.background?.src!==background.src||!during.piece)break;
              const delta=target-during.piece.rect.x;if(Math.abs(delta)<1)break;
              x=Math.round(Math.min(slider.x+background.rect.width-slider.width/2,Math.max(start.x,x+delta)));
              await input.send({type:'mouseMove',x,y:start.y,button:'left',modifiers:['leftbuttondown']});await delay(100);
            }
          }
        }finally{if(!win.isDestroyed())await input.send({type:'mouseUp',x,y:start.y,button:'left',clickCount:1});}
        for(let i=0;i<25&&alive();i++){await delay(200);state=await inspect();if(state.verified)break;if(state.background&&state.background.src!==background.src)break;}
        options.diagnostic?.({phase:'verification',verified:state.verified,widgetClasses:state.widgetClasses,message:state.message});
        if(state.verified)break;
        challengeFailure='官网未通过滑块验证';
      }else challengeFailure='未能可靠识别滑块位置';
      if(attempts<3){
        state=await inspect();const previousSource=state.background?.src;
        if(state.refresh)await click(state.refresh);
        for(let i=0;i<15&&alive();i++){await delay(100);state=await inspect();if(state.verified||!state.background||state.background.src!==previousSource)break;}
      }
    }
    if(!state.verified)throw new Error(`${challengeFailure}（${Math.min(attempts,3)} 次），请手动验证。`);
    if(!alive())throw new Error('自动登录已停止。');
    const accepted=await win.webContents.executeJavaScript(`(${acceptExistingAgreement.toString()})(${JSON.stringify(number)})`);
    // A green widget may precede its form token; its popup can also cover the sign-in button.
    const formDeadline=Date.now()+4000;let stableForm=0;
    while(alive()&&Date.now()<formDeadline){
      const previous=state;await delay(150);state=await inspect();
      const stable=state.submit&&previous.submit&&Math.abs(state.submit.x-previous.submit.x)<.5&&Math.abs(state.submit.y-previous.submit.y)<.5;
      stableForm=state.validationReady&&state.submitReady&&stable?stableForm+1:0;
      if(stableForm>=2)break;
    }
    options.diagnostic?.({phase:'form-ready',validationReady:state.validationReady,submitReady:state.submitReady,stableForm});
    if(!accepted||!state.accountMatches||!state.verified||!state.submit)throw new Error('官网登录条件发生变化，请在窗口中核对。');
    if(stableForm<2)throw new Error('官网验证结果或登录按钮尚未就绪，请手动继续。');
    options.progress('滑块已通过，正在通过官网表单登录。');
    await click(state.submit);
    for(let i=0;i<10&&alive();i++){
      await delay(600);
      if(await options.loggedIn())return{ok:true,attempts:Math.min(attempts,3),reason:'官网登录成功。'};
      state=await inspect();
      options.diagnostic?.({phase:'login-confirmation',ready:state.ready,message:state.message});
      if(/密码.*(?:错误|不正确)|卡号.*(?:错误|不存在)|卡券.*(?:已使用|无效|冻结)/.test(state.message))throw new Error('官网未接受卡号或密码，请在窗口核对；已停止自动重试。');
      if(!state.ready)break;
    }
    throw new Error('官网尚未确认登录，可能需要额外验证；请在窗口继续。');
  }catch(error){return{ok:false,attempts:Math.min(attempts,3),reason:error instanceof Error?error.message:'自动登录未完成，请在官网窗口继续。'};}
  finally{input?.dispose();}
}
