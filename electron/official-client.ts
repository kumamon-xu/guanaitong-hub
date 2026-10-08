import type { FailureKind } from '../src/shared/operations';
import { API_BASE, LOGIN_URL, LoginRequired } from './adapter';
import type { CategoryRequestMethod } from './categories';

export const READ_ENDPOINTS: Record<string, CategoryRequestMethod> = {
  'common/getCurrentInfo':'GET','common/getCommonInfo':'POST','address/list':'GET','address/getById':'GET',
  'product/list':'GET','exchangeOrder/list':'GET','card/getProductHomeUrl':'GET',
  'product/cmsQueryProductCategory':'POST','product/cmsQueryProduct':'POST_JSON',
};
export class OfficialFailure extends Error {
  constructor(readonly kind: FailureKind, readonly endpoint: string, message: string) { super(message); }
}
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof OfficialFailure) return error.kind;
  if (error instanceof LoginRequired) return 'login';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  const message = error instanceof Error ? error.message : '';
  if (/另一张卡|其他卡号|来源卡号|属于其他|串卡/.test(message)) return 'identity';
  if (/字段|结构|格式|分页|不完整|同步上限/.test(message)) return 'schema';
  if (/数据库|加密|安全存储|SQLITE|keychain|磁盘/.test(message)) return 'storage';
  return 'unknown';
}
export function throwIfCancelled(signal?: AbortSignal): void { signal?.throwIfAborted(); }

/** Only known read endpoints retry transient failures; neither cookies nor response bodies enter errors. */
export async function readOfficial(fetcher: typeof fetch, path: string, params: Record<string, unknown> = {}, method: CategoryRequestMethod = 'GET', signal?: AbortSignal): Promise<unknown> {
  if (READ_ENDPOINTS[path] !== method) throw new OfficialFailure('schema', path, '接口不在只读允许范围内');
  const url = new URL(API_BASE + path);
  const headers: Record<string, string> = { Accept:'application/json',platform:'browser',channel:'common','Client-Type':'2',version:'1.0.0','Ecapp-Code':'card_exchange',Referer:LOGIN_URL,Origin:'https://a.guanaitong.com' };
  let body: string | undefined;
  if (method === 'GET') for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  else if (method === 'POST_JSON') { headers['Content-Type']='application/json'; body=JSON.stringify(params); }
  else { headers['Content-Type']='application/x-www-form-urlencoded'; body=new URLSearchParams(Object.entries(params).map(([key, value])=>[key,String(value)])).toString(); }
  for (let attempt=0; attempt<2; attempt++) {
    throwIfCancelled(signal);
    try {
      const response = await fetcher(url.toString(), { method:method==='GET'?'GET':'POST', body, headers, credentials:'include', redirect:'error', signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
      if(response.status===401||response.status===403)throw new LoginRequired(`官网接口 ${path} 会话已失效，请重新登录`);
      if (!response.ok) throw new OfficialFailure('http',path,`官网接口 ${path} 读取失败（HTTP ${response.status}）`);
      let value: unknown;
      try { value = await response.json(); } catch { throw new OfficialFailure('schema',path,`官网接口 ${path} 返回格式发生变化`); }
      if (!value || typeof value!=='object' || Array.isArray(value) || !('code' in value)) throw new OfficialFailure('schema',path,`官网接口 ${path} 缺少响应状态`);
      return value;
    } catch (error) {
      throwIfCancelled(signal);
      if(error instanceof LoginRequired)throw error;
      if (error instanceof OfficialFailure && (!['http'].includes(error.kind) || !/HTTP (429|5\d\d)/.test(error.message))) throw error;
      if (attempt===1) throw error instanceof OfficialFailure ? error : new OfficialFailure(classifyFailure(error)==='timeout'?'timeout':'network',path,`官网接口 ${path} ${classifyFailure(error)==='timeout'?'读取超时':'网络读取失败'}`);
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},300);
        const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
        signal?.addEventListener('abort',abort,{once:true});
      });
    }
  }
  throw new OfficialFailure('network',path,'官网读取失败');
}
