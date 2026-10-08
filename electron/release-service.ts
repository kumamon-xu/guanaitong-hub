import type { UpdateInfo } from '../src/shared/operations';
import type { SqliteRepository } from './sqlite-repository';

function httpsURL(value:unknown):string{
  if(typeof value!=='string'||value.length>2000)throw new Error('发布地址无效');
  const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('发布地址须为不含账户信息的 HTTPS 地址');return url.toString();
}
export function compareVersions(first:string,second:string):number{
  const parse=(value:string)=>{if(!/^\d+\.\d+\.\d+$/.test(value))throw new Error('发布版本须为 x.y.z');const parts=value.split('.').map(Number);if(parts.some(value=>!Number.isSafeInteger(value)))throw new Error('发布版本无效');return parts;};
  const a=parse(first),b=parse(second);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i]?1:-1;return 0;
}
export class ReleaseService {
  private checked:UpdateInfo|null=null;
  constructor(private readonly version:string,private readonly platform:string,private readonly arch:string,private readonly fetcher:typeof fetch,private readonly database:SqliteRepository,private readonly openExternal:(url:string)=>Promise<void>){}
  async check(feed:string):Promise<UpdateInfo>{
    this.checked=null;
    if(!feed)throw new Error('请先填写维护者提供的 HTTPS 发布清单地址');
    const response=await this.fetcher(httpsURL(feed),{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`更新检查失败（HTTP ${response.status}）`);
    if(Number(response.headers.get('content-length'))>256*1024)throw new Error('发布清单过大');
    const reader=response.body?.getReader();if(!reader)throw new Error('发布清单为空');
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>256*1024)throw new Error('发布清单过大');chunks.push(item.value);}}finally{await reader.cancel();}
    let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('发布清单格式无效');}
    if(value?.format!=='guanaitong-release'||value.schemaVersion!==1||typeof value.version!=='string'||typeof value.notes!=='string'||value.notes.length>20000||typeof value.publishedAt!=='string'||!Number.isFinite(Date.parse(value.publishedAt)))throw new Error('发布清单字段无效');
    const asset=value.downloads?.[`${this.platform}-${this.arch}`];
    if(!asset||typeof asset.sha256!=='string'||!/^[0-9a-f]{64}$/i.test(asset.sha256))throw new Error('发布清单缺少当前系统的安装包或校验值');
    const result:UpdateInfo={currentVersion:this.version,version:value.version,available:compareVersions(value.version,this.version)>0,notes:value.notes,url:httpsURL(asset.url),publishedAt:value.publishedAt};
    this.checked=result;return result;
  }
  async open():Promise<void>{
    if(!this.checked?.available)throw new Error('请先检查可用的新版本');
    await this.database.enqueueWrite(()=>this.database.backup('before-program-update'));
    await this.openExternal(this.checked.url);
  }
}
