import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw, ShoppingBag, X } from 'lucide-react';
import type { Card, HubAPI } from './shared/types';
import type { TradeAttemptView, TradeContext, TradePreview, TradeReference, TradeSelection } from './shared/trade';
import { cardNumber } from './shared/card-display';

export default function TradeDialog({ api, card, items, maskNumbers, onClose, onSubmitted }: { api: HubAPI; card: Card; items: TradeReference[]; maskNumbers: boolean; onClose: () => void; onSubmitted: () => void }) {
  const [context, setContext] = useState<TradeContext | null>(null), [selections, setSelections] = useState<TradeSelection[]>([]);
  const [addressId, setAddressId] = useState(''), [remark, setRemark] = useState('');
  const [preview, setPreview] = useState<TradePreview | null>(null), [receipt, setReceipt] = useState<TradeAttemptView | null>(null);
  const [busy, setBusy] = useState('context'), [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [accepted, setAccepted] = useState(false);
  const [now, setNow] = useState(Date.now()); const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    api.getTradeContext(card.id, items).then(value => {
      if (!active) return;
      setContext(value); setAddressId(value.addresses.find(row => row.isDefault)?.id ?? value.addresses[0]?.id ?? '');
      setSelections(items.map((item, index) => { const choices = value.products[index].skus.filter(sku => sku.stock !== 0); return { ...item, skuCode: choices.length === 1 ? choices[0].code : '', packageReplacements: [] }; }));
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [api, card.id]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null; dialog.current?.focus();
    return () => before?.focus();
  }, []);
  const change = (index: number, patch: Partial<TradeSelection>) => setSelections(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  const run = async (key: string, work: () => Promise<void>) => { setBusy(key); setError(''); try { await work(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(''); } };
  const expires = !!preview && Date.parse(preview.expiresAt) <= now;
  const ready = !!context && !!addressId && selections.length === items.length && selections.every(row => row.skuCode && Number.isInteger(row.quantity) && row.quantity >= 1 && row.quantity <= 99);
  const format = (amount: number) => amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const submit = () => run('submit', async () => {
    if (!preview) return;
    const result = await api.submitOrder({ previewId: preview.id, digest: preview.digest, confirmDeduction: confirm, acceptAgreements: accepted });
    setReceipt(result); setPreview(null); onSubmitted();
  });
  return <div className="modal-backdrop"><div className="modal wide trade-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="应用内结算" onKeyDown={event => {
    if (event.key === 'Escape' && busy !== 'submit') onClose();
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div className="modal-head"><div><h2>应用内结算</h2><p>{card.label} · {cardNumber(card, maskNumbers)}</p></div><button className="icon-button" aria-label="关闭结算" disabled={busy === 'submit'} onClick={onClose}><X size={20} /></button></div>
    {busy && <p className="trade-loading" role="status"><LoaderCircle size={16} className="spin" />{busy === 'submit' ? '正在提交扣卡兑换，请等待结果…' : busy === 'preview' ? '正在核对实时价格、库存和配送…' : busy === 'query' ? '正在查询订单状态…' : '正在读取商品规格与本卡地址…'}</p>}
    {error && <p className="text-error trade-error" role="alert">{error}</p>}
    {!receipt && !preview && context && <>
      {context.previewOnly && <p className="inline-note trade-test-mode">结算预览测试模式：最终提交已在后端禁用。</p>}
      <div className="trade-products">{context.products.map((product, index) => {
        const selection = selections[index]; if (!selection) return null;
        const sku = product.skus.find(row => row.code === selection.skuCode);
        const maximum = Math.min(99, sku?.stock ?? 99, sku?.limit ?? 99);
        return <section className="trade-product" key={product.sourceId}><div><ShoppingBag size={18} /><h3>{product.name}</h3></div><label className="form-field">商品规格<select aria-label={`结算规格 ${index + 1}`} value={selection.skuCode} disabled={!!busy} onChange={event => change(index, { skuCode: event.target.value })}><option value="">请选择规格</option>{product.skus.map(row => <option key={row.code} value={row.code} disabled={row.stock === 0}>{row.label}{row.price !== null ? ` · ${format(row.price)} 额度` : ''}{row.stock === 0 ? ' · 售罄' : ''}</option>)}</select></label>
          {product.packageItems.map(part => <label className="form-field" key={part.originalSku}>{part.name} ×{part.quantity}<select aria-label={`组合规格 ${part.name}`} value={selection.packageReplacements?.find(row => row.originalSku === part.originalSku)?.skuCode ?? part.originalSku} disabled={!!busy} onChange={event => change(index, { packageReplacements: [...(selection.packageReplacements ?? []).filter(row => row.originalSku !== part.originalSku), { originalSku: part.originalSku, skuCode: event.target.value }] })}>{part.skus.map(row => <option key={row.code} value={row.code} disabled={row.stock === 0}>{row.label}</option>)}</select></label>)}
          <label className="form-field">兑换数量<input aria-label={`结算数量 ${index + 1}`} type="number" min={1} max={Math.max(1, maximum)} value={selection.quantity} disabled={!!busy} onChange={event => change(index, { quantity: Math.max(1, Math.min(Math.max(1, maximum), Math.trunc(Number(event.target.value) || 1))) })} /></label><p className="muted-small">{product.description || '结算时将重新读取实时规格、价格和配送结果。'}</p></section>;
      })}</div>
      <label className="form-field">本卡官网收货地址<select aria-label="结算收货地址" value={addressId} disabled={!!busy} onChange={event => setAddressId(event.target.value)}><option value="">请选择地址</option>{context.addresses.map(address => <option key={address.id} value={address.id}>{address.draft.recipient} · {address.draft.phone} · {[address.draft.province, address.draft.city, address.draft.district, address.draft.detail].join(' ')}</option>)}</select></label>
      {!context.addresses.length && <p className="text-error">该卡没有官网地址，请先在收货地址页添加并确认，再回来结算。</p>}
      <label className="form-field">订单备注 <span>选填</span><textarea aria-label="兑换备注" maxLength={200} rows={2} value={remark} disabled={!!busy} onChange={event => setRemark(event.target.value)} /></label>
      <div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={onClose}>取消</button><button className="button primary" disabled={!ready || !!busy} onClick={() => void run('preview', async () => { const value = await api.previewOrder({ cardId: card.id, addressId, items: selections, remark }); setPreview(value); setConfirm(false); setAccepted(!value.agreements.length); setNow(Date.now()); })}>获取结算预览</button></div>
    </>}
    {preview && !receipt && <div className="trade-confirmation">
      <h3>确认本卡兑换内容</h3><ul className="trade-lines">{preview.lines.map((line, index) => <li key={index}><div><strong>{line.name}</strong><p>{line.specification} ×{line.quantity}</p></div><b>{format(line.price * line.quantity)} 额度</b></li>)}</ul>
      <div className="trade-address"><strong>{preview.address.draft.recipient} · {preview.address.draft.phone}</strong><p>{[preview.address.draft.province, preview.address.draft.city, preview.address.draft.district, preview.address.draft.town, preview.address.draft.detail].filter(Boolean).join(' ')}</p></div>
      <div className="trade-totals"><p>兑换额 <strong>{format(preview.deduction)} 额度</strong></p><p>商品件数 <strong>{preview.pieces} 件</strong></p><p>配送运费 <strong>{format(preview.freight)}</strong></p><p>本卡可用额度 <strong>{format(preview.balance)}</strong></p>{preview.remaining !== null && <p>兑换后预估余量 <strong>{format(preview.remaining)}</strong></p>}{preview.balanceMode === 'selection-limit' && <p>该卡按单次任选额度兑换，剩余条件以订单核对结果为准。</p>}</div>
      {preview.agreements.map((agreement, index) => <section className="trade-agreement" key={index}><h4>{agreement.name}</h4>{agreement.content && <pre>{agreement.content}</pre>}{agreement.url && <button className="text-link" disabled={!!busy} onClick={() => void run('agreement', () => api.openTradeAgreement(preview.id, index))}>查看商品协议文档</button>}</section>)}
      {!!preview.agreements.length && <label className="trade-checkbox"><input aria-label="接受商品协议" type="checkbox" checked={accepted} disabled={!!busy} onChange={event => setAccepted(event.target.checked)} />我已阅读并接受本次商品协议</label>}
      <label className="trade-checkbox"><input aria-label="确认扣卡额度" type="checkbox" checked={confirm} disabled={!!busy || preview.previewOnly} onChange={event => setConfirm(event.target.checked)} />我已核对规格、数量、地址，确认使用此卡兑换</label>
      <p className="muted-small">{preview.previewOnly ? '真实测试仅到结算预览，不会提交订单或扣卡。' : '点击确认提交后会产生真实订单并扣减本卡额度。结果未知时系统不会自动重发。'}</p>
      {expires && <p className="text-error">预览已过期，请重新获取实时结算。</p>}
      <div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={() => { setPreview(null); setConfirm(false); }}>返回修改</button><button className="button primary" aria-label="确认提交扣卡订单" disabled={!!busy || !confirm || !accepted || expires || preview.previewOnly} onClick={() => void submit()}>确认提交扣卡订单</button></div>
    </div>}
    {receipt && <div className="trade-receipt"><CheckCircle2 size={32} /><h3>{receipt.status === 'succeeded' ? '兑换成功' : receipt.status === 'rejected' ? '官网未接受订单' : receipt.status === 'closed' ? '订单已关闭' : receipt.status === 'partial' ? '部分订单完成' : '订单结果待核对'}</h3><p>{receipt.message}</p>{receipt.orderCode && <p>官网订单号：{receipt.orderCode}</p>}<p>兑换额：{format(receipt.deduction)} {receipt.balanceUnit}</p><p className="muted-small">原兑换清单保留。核对成功后可移除已兑换商品，避免重复规划。</p><div className="modal-actions">{!['succeeded', 'rejected', 'closed', 'partial'].includes(receipt.status) && <button className="button secondary" disabled={!!busy} onClick={() => void run('query', async () => { setReceipt(await api.queryTradeAttempt(receipt.id)); onSubmitted(); })}><RefreshCw size={14} />查询订单状态</button>}<button className="button primary" disabled={!!busy} onClick={onClose}>完成</button></div></div>}
  </div></div>;
}
