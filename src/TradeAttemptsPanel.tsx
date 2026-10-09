import { useEffect, useState } from 'react';
import type { HubAPI } from './shared/types';
import type { TradeAttemptView } from './shared/trade';
import { needsTradeReconciliation } from './shared/trade';

export default function TradeAttemptsPanel({ api, revision, onMessage }: { api: HubAPI; revision: number; onMessage: (message: string, error?: boolean) => void }) {
  const [rows, setRows] = useState<TradeAttemptView[]>([]), [busy, setBusy] = useState('');
  useEffect(() => { let active = true; api.getTradeAttempts().then(rows => { if (active) setRows(rows); }).catch(error => onMessage(error.message, true)); return () => { active = false; }; }, [api, revision]);
  if (!rows.length) return null;
  const labels = { submitting: '提交中', submitted: '已生成，待核对', succeeded: '兑换成功', rejected: '官网拒绝', unknown: '结果未知',closed:'订单已关闭',partial:'部分订单完成' };
  return <section className="trade-attempts"><h2>应用内兑换记录</h2><p className="muted-small">待核对 {rows.filter(row=>needsTradeReconciliation(row.status)).length} 条始终保留；另显示最近 100 条已结束记录。</p>{rows.map(row => <article key={row.id}><div><strong>{labels[row.status]}</strong><p>{row.lines.map(line => `${line.name} ×${line.quantity}`).join('、')}</p><p>{row.orderCode ? `订单号 ${row.orderCode}` : '未取得确定订单号'} · {new Date(row.startedAt).toLocaleString('zh-CN')}</p><p>{row.message}</p></div><button className="button secondary small" disabled={!!busy || ['succeeded', 'rejected', 'submitting'].includes(row.status)} onClick={() => { setBusy(row.id); void api.queryTradeAttempt(row.id).then(next => setRows(rows => rows.map(item => item.id === next.id ? next : item))).catch(error => onMessage(error.message, true)).finally(() => setBusy('')); }}>查询并核对</button></article>)}</section>;
}
