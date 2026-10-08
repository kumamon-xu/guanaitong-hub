export class LoginCoordinator {
  private active=new Map<string,Promise<boolean>>();
  private tail:Promise<unknown>=Promise.resolve();
  private failures=new Map<string,number>();
  private failureReasons=new Map<string,string>();
  constructor(private readonly now=()=>Date.now(),private readonly cooldownMs=60_000){}
  isRunning(id:string){return this.active.has(id);}
  failureReason(id:string){return this.failureReasons.get(id);}
  authenticated(id:string){this.failures.delete(id);this.failureReasons.delete(id);}
  run(id:string,work:()=>Promise<boolean|{ok:boolean;reason:string}>):Promise<boolean>{
    const existing=this.active.get(id);if(existing)return existing;
    if(this.failures.has(id)&&this.now()-this.failures.get(id)!<this.cooldownMs)return Promise.resolve(false);
    const pending=this.tail.catch(()=>{}).then(work).then(result=>{
      const ok=typeof result==='boolean'?result:result.ok;
      if(ok)this.authenticated(id);
      else{this.failures.set(id,this.now());if(typeof result!=='boolean')this.failureReasons.set(id,result.reason);}
      return ok;
    },error=>{this.failures.set(id,this.now());this.failureReasons.set(id,error instanceof Error?error.message:'自动登录失败，请手动继续。');return false;}).finally(()=>this.active.delete(id));
    this.active.set(id,pending);this.tail=pending;return pending;
  }
}
