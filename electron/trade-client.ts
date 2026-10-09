import { API_BASE, LOGIN_URL, LoginRequired } from './adapter';

export type TradeMethod = 'GET' | 'POST' | 'POST_JSON';
const PREVIEW_ENDPOINTS: Record<string, TradeMethod> = {
  'common/getCurrentInfo': 'GET', 'common/getCommonInfo': 'POST', 'address/list': 'GET',
  'product/detail': 'GET', 'product/check': 'POST', 'cart/getSettlementInfo': 'POST_JSON',
  'exchangeOrder/riskValidate': 'POST_JSON', 'exchangeOrder/list': 'GET', 'exchangeOrder/getPaymentResult': 'GET',
};
export class TradeTransportError extends Error {}
export class TradeBusinessError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
export interface TradeTransport {
  request(cardId: string, path: string, params?: Record<string, unknown>, method?: TradeMethod): Promise<any>;
  exchange(cardId: string, params: Record<string, unknown>): Promise<any>;
}
/** Trade requests are never retried. The final mutation has its own fixed path. */
export function createTradeTransport(fetcher: (cardId: string) => Promise<typeof fetch>, previewOnly = false): TradeTransport {
  async function send(cardId: string, path: string, params: Record<string, unknown>, method: TradeMethod): Promise<any> {
    const url = new URL(API_BASE + path);
    const headers: Record<string, string> = { Accept: 'application/json', platform: 'browser', channel: 'common', 'Client-Type': '2', version: '1.0.0', 'Ecapp-Code': 'card_exchange', Referer: LOGIN_URL, Origin: 'https://a.guanaitong.com' };
    let body: string | undefined;
    if (method === 'GET') for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    else {
      headers['Content-Type'] = method === 'POST_JSON' ? 'application/json' : 'application/x-www-form-urlencoded';
      body = method === 'POST_JSON' ? JSON.stringify(params) : new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
    }
    try {
      const response = await (await fetcher(cardId))(url.toString(), { method: method === 'GET' ? 'GET' : 'POST', headers, body, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(25000) });
      if (response.status === 401 || response.status === 403) throw new LoginRequired('当前卡片会话失效，请重新登录后检查订单状态');
      if (!response.ok) throw new TradeTransportError('交易接口响应异常（HTTP ' + response.status + '），请检查订单状态');
      const reader = response.body?.getReader(); if (!reader) throw new TradeTransportError('交易响应为空');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 8 * 1024 * 1024) throw new TradeTransportError('交易响应超过大小限制'); chunks.push(next.value); }
      } finally { await reader.cancel(); }
      let result: any;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new TradeTransportError('交易响应格式发生变化'); }
      if (!result || !Number.isInteger(result.code)) throw new TradeTransportError('交易响应缺少业务状态');
      if (result.code === 1134301002) throw new LoginRequired('当前卡片会话失效，请重新登录后检查订单状态');
      if (result.code !== 0) throw new TradeBusinessError(result.code, typeof result.msg === 'string' ? result.msg.slice(0, 1000) : '官网未接受本次交易请求');
      if (path !== 'exchangeOrder/riskValidate' && (!result.data || typeof result.data !== 'object')) throw new TradeTransportError('交易响应缺少结果');
      return result.data;
    } catch (error) {
      if (error instanceof TradeBusinessError || error instanceof LoginRequired || error instanceof TradeTransportError) throw error;
      throw new TradeTransportError('交易连接中断或超时，请检查订单状态，不能自动重新提交');
    }
  }
  return {
    request: (cardId, path, params = {}, method = PREVIEW_ENDPOINTS[path]) => {
      if (!PREVIEW_ENDPOINTS[path] || method !== PREVIEW_ENDPOINTS[path]) return Promise.reject(new Error('接口不在交易查询或预览范围内'));
      return send(cardId, path, params, method);
    },
    exchange: (cardId, params) => {
      if (previewOnly) return Promise.reject(new Error('真实测试仅允许结算预览，最终下单已禁用'));
      return send(cardId, 'exchangeOrder/exchange', params, 'POST_JSON');
    },
  };
}
