import type { BrowserWindow } from 'electron';
import type { LoginResult } from './auto-login';

/** Success/cancellation frees the renderer; failure hands the same page to the user. */
export async function finishHiddenLogin(options:{
  window:BrowserWindow;
  recover:()=>Promise<LoginResult>;
  enabled:()=>boolean;
  handOff:(window:BrowserWindow)=>void;
}):Promise<LoginResult>{
  const win=options.window;
  let result:LoginResult;
  try{result=await options.recover();}
  catch(error){result={ok:false,attempts:0,reason:error instanceof Error?error.message:'自动登录未完成，请在官网窗口继续。'};}
  if(!win.isDestroyed()){
    if(!result.ok&&options.enabled()){
      win.webContents.setBackgroundThrottling(true);
      options.handOff(win);
      win.show();win.focus();
    }else win.destroy();
  }
  return result;
}
