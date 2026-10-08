import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchSlider, type PixelImage } from '../electron/slider-match';
import { allowedChallengeImage } from '../electron/auto-login';
import { LoginCoordinator } from '../electron/login-coordinator';
import { createLoginInput } from '../electron/login-input';
import { finishHiddenLogin } from '../electron/login-window';
import type { BrowserWindow, WebContents } from 'electron';

function fixture(offset=147,top=26,shade=.65){
  let seed=782934;
  const background:PixelImage={width:256,height:128,data:new Uint8ClampedArray(256*128*4)};
  const bg=background.data as Uint8ClampedArray;
  for(let i=0;i<bg.length;i+=4){for(let c=0;c<3;c++){seed=(1664525*seed+1013904223)>>>0;bg[i+c]=40+seed%200;}bg[i+3]=255;}
  const piece:PixelImage={width:52,height:64,data:new Uint8ClampedArray(52*64*4)};
  const fg=piece.data as Uint8ClampedArray;
  for(let y=0;y<64;y++)for(let x=0;x<52;x++){
    const shape=(x>=8&&x<44&&y>=14&&y<54)||((x-26)**2+(y-14)**2<64);
    if(!shape)continue;
    const a=4*(y*52+x),b=4*((top+y)*256+offset+x);
    for(let c=0;c<3;c++){fg[a+c]=bg[b+c];bg[b+c]*=shade;}fg[a+3]=255;
  }
  return{background,piece,offset,top};
}
test('local matching identifies a darkened puzzle with transparent margins and vertical placement',()=>{
  for(const offset of [38,104,181]){
    const f=fixture(offset,31,.55);const result=matchSlider(f.background,f.piece,f.top);
    assert.ok(result);assert.ok(Math.abs(result.x-offset)<=1);assert.ok(Math.abs(result.y-f.top)<=1);assert.ok(result.confidence>.9);
  }
});
test('flat, malformed, ambiguous, or out-of-bounds images never become an automatic drag',()=>{
  const f=fixture();
  assert.equal(matchSlider(f.background,f.piece,-50),null);
  assert.equal(matchSlider({...f.background,width:3000},f.piece,0),null);
  assert.equal(matchSlider({...f.background,data:[]},f.piece,0),null);
  assert.equal(matchSlider(f.background,f.piece,NaN),null);
  assert.equal(matchSlider({...f.background,data:new Uint8ClampedArray(f.background.data.length)},f.piece,f.top),null);
  const unrelated=fixture(18,4).piece;
  assert.equal(matchSlider(f.background,unrelated,f.top),null);
});
test('CAPTCHA image reads are restricted to provider images, never arbitrary destinations',()=>{
  assert.ok(allowedChallengeImage('https://cstaticdun.126.net.nos-eastchina1.126.net/image.png'));
  assert.ok(allowedChallengeImage('https://necaptcha.nosdn.127.net/image.png'));
  for(const url of ['http://necaptcha.nosdn.127.net/a','https://nosdn.127.net.evil.example/a','https://127.0.0.1/a','https://user:password@nosdn.127.net/a','https://nosdn.127.net:8080/a','file:///tmp/test'])assert.equal(allowedChallengeImage(url),false);
});
test('same-card recovery is shared and separate cards are processed sequentially',async()=>{
  const coordinator=new LoginCoordinator();const calls:string[]=[];
  let finish!:()=>void;const barrier=new Promise<void>(resolve=>finish=resolve);
  const first=coordinator.run('a',async()=>{calls.push('a:start');await barrier;calls.push('a:end');return true;});
  const duplicate=coordinator.run('a',async()=>{throw new Error('duplicate must not run');});
  const second=coordinator.run('b',async()=>{calls.push('b');return true;});
  assert.equal(first,duplicate);assert.ok(coordinator.isRunning('a'));
  await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(calls,['a:start']);
  finish();assert.deepEqual(await Promise.all([first,duplicate,second]),[true,true,true]);
  assert.deepEqual(calls,['a:start','a:end','b']);assert.equal(coordinator.isRunning('a'),false);
});
test('failed recovery has a cooldown; an exception cannot block another card',async()=>{
  let now=1000;const coordinator=new LoginCoordinator(()=>now,500);let calls=0;
  assert.equal(await coordinator.run('a',async()=>{calls++;throw new Error('network');}),false);
  assert.equal(await coordinator.run('a',async()=>{calls++;return true;}),false);assert.equal(calls,1);
  assert.equal(await coordinator.run('b',async()=>true),true);
  now+=501;assert.equal(await coordinator.run('a',async()=>{calls++;return true;}),true);assert.equal(calls,2);
});
test('the actual login failure survives cooldown retries and clears after verified authentication',async()=>{
  let now=1000;const coordinator=new LoginCoordinator(()=>now,500);const reason='官网未通过滑块验证（3 次），请手动验证。';
  assert.equal(await coordinator.run('new',async()=>({ok:false,reason})),false);
  assert.equal(coordinator.failureReason('new'),reason);
  assert.equal(await coordinator.run('new',async()=>assert.fail('cooldown must not retry')),false);
  assert.equal(coordinator.failureReason('new'),reason);
  coordinator.authenticated('new');assert.equal(coordinator.failureReason('new'),undefined);
  assert.equal(await coordinator.run('new',async()=>true),true);
  now+=501;assert.equal(await coordinator.run('other',async()=>{throw new Error('验证码图片读取失败。');}),false);
  assert.equal(coordinator.failureReason('other'),'验证码图片读取失败。');
});

test('hidden browser input preserves held/released buttons and releases its own transport',async()=>{
  let attached=false,detaches=0;const commands:{method:string;params:any}[]=[];
  const captures:{rect:unknown;options:unknown}[]=[];
  const contents={capturePage:async(rect:unknown,options:unknown)=>{captures.push({rect,options});},debugger:{isAttached:()=>attached,attach:()=>{attached=true;},detach:()=>{attached=false;detaches++;},sendCommand:async(method:string,params:any)=>{commands.push({method,params});}}} as unknown as WebContents;
  const input=createLoginInput(contents);
  await input.send({type:'mouseDown',x:20,y:30,button:'left',clickCount:1});
  await input.send({type:'mouseMove',x:120,y:30,button:'left',modifiers:['leftbuttondown']});
  await input.send({type:'mouseUp',x:120,y:30,button:'left',clickCount:1});
  assert.deepEqual(commands.map(c=>[c.method,c.params.type,c.params.buttons]),[['Input.dispatchMouseEvent','mousePressed',1],['Input.dispatchMouseEvent','mouseMoved',1],['Input.dispatchMouseEvent','mouseReleased',0]]);
  assert.equal(captures.length,process.platform==='win32'?3:0);
  for(const capture of captures)assert.deepEqual(capture,{rect:{x:0,y:0,width:1,height:1},options:{stayHidden:true,stayAwake:true}});
  await assert.rejects(input.send({type:'mouseMove',x:NaN,y:30}));
  input.dispose();input.dispose();assert.equal(detaches,1);
  await assert.rejects(input.send({type:'mouseDown',x:20,y:30}));
  attached=true;assert.throws(()=>createLoginInput(contents));assert.equal(attached,true);
});

function hiddenWindow(){
  const events:string[]=[];let destroyed=false;
  const window={isDestroyed:()=>destroyed,destroy:()=>{destroyed=true;events.push('destroy');},show:()=>events.push('show'),focus:()=>events.push('focus'),webContents:{setBackgroundThrottling:(value:boolean)=>events.push(`throttle:${value}`)}} as unknown as BrowserWindow;
  return{window,events};
}
test('successful hidden login disposes the renderer without showing or focusing it',async()=>{
  const f=hiddenWindow();
  const result=await finishHiddenLogin({window:f.window,enabled:()=>true,recover:async()=>({ok:true,attempts:1,reason:'ok'}),handOff:()=>assert.fail('unexpected fallback')});
  assert.equal(result.ok,true);assert.deepEqual(f.events,['destroy']);
});
test('three failed attempts hand off the same page before showing and focusing it',async()=>{
  const f=hiddenWindow();let attempts=0;
  const result=await finishHiddenLogin({window:f.window,enabled:()=>true,recover:async()=>{for(let i=0;i<3;i++){attempts++;assert.deepEqual(f.events,[]);}return{ok:false,attempts,reason:'manual'};},handOff:window=>{assert.equal(window,f.window);f.events.push('handoff');}});
  assert.equal(result.attempts,3);assert.deepEqual(f.events,['throttle:true','handoff','show','focus']);
});
test('disabling login or closing the app disposes hidden recovery and suppresses manual fallback',async()=>{
  const f=hiddenWindow();
  await finishHiddenLogin({window:f.window,enabled:()=>false,recover:async()=>({ok:false,attempts:1,reason:'stopped'}),handOff:()=>assert.fail('unexpected fallback')});
  assert.deepEqual(f.events,['destroy']);
});
test('an unexpected recovery failure cannot leave a hidden page running indefinitely',async()=>{
  const f=hiddenWindow();
  const result=await finishHiddenLogin({window:f.window,enabled:()=>true,recover:async()=>{throw new Error('page changed');},handOff:()=>f.events.push('handoff')});
  assert.equal(result.ok,false);assert.equal(result.reason,'page changed');assert.deepEqual(f.events,['throttle:true','handoff','show','focus']);
});
