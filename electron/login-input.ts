import type { MouseInputEvent, WebContents } from 'electron';

/** Browser input scoped to the hidden login renderer; no OS focus or remote debug port. */
export function createLoginInput(contents:Pick<WebContents,'debugger'|'capturePage'>) {
  const transport=contents.debugger;
  if(transport.isAttached())throw new Error('登录页面正在被其他工具使用，请手动继续。');
  transport.attach('1.3');
  let disposed=false;
  return {
    async send(event:MouseInputEvent) {
      if(disposed||!transport.isAttached())throw new Error('自动登录输入已停止。');
      if(!Number.isFinite(event.x)||!Number.isFinite(event.y)||event.x<0||event.y<0)throw new Error('登录控件位置无效。');
      const types:Partial<Record<MouseInputEvent['type'],string>>={mouseMove:'mouseMoved',mouseDown:'mousePressed',mouseUp:'mouseReleased'};
      const type=types[event.type];
      if(!type)throw new Error('登录输入类型暂不支持。');
      const held=event.type==='mouseDown'||event.modifiers?.includes('leftbuttondown');
      const dispatched=transport.sendCommand('Input.dispatchMouseEvent',{
        type,x:event.x,y:event.y,button:event.button??'none',buttons:held?1:0,clickCount:event.clickCount??0,
      });
      if(process.platform==='win32') {
        // A hidden Windows renderer otherwise acknowledges mouse moves at about 1 fps.
        // Request one pixel to drive a frame, keeping the page hidden and discarding the image.
        await Promise.all([dispatched,contents.capturePage({x:0,y:0,width:1,height:1},{stayHidden:true,stayAwake:true})]);
      }else await dispatched;
    },
    dispose() {
      if(disposed)return;
      disposed=true;
      try{if(transport.isAttached())transport.detach();}catch{/* The window may already be destroyed. */}
    },
  };
}
