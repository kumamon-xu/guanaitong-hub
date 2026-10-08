import { ChevronDown, Check, SlidersHorizontal, X } from 'lucide-react';
import { EMPTY_PRICE_FILTER, resolvePriceFilter, type PriceFilterValue } from './shared/price-filter';

export interface PriceFilterProps {
  value: PriceFilterValue;
  onChange: (value: PriceFilterValue) => void;
  units: readonly string[];
  amounts: readonly number[];
  disabled?: boolean;
}

export default function PriceFilter({ value, onChange, units, amounts, disabled = false }: PriceFilterProps) {
  const filter = resolvePriceFilter(value);
  const listedUnits = [...new Set([...units, ...(value.unit !== 'all' && !units.includes(value.unit) ? [value.unit] : [])])];
  const effectiveUnit = value.unit !== 'all' ? value.unit : units.length === 1 ? units[0] : '';
  const needsUnit = value.unit === 'all' && units.length > 1;
  // Keep a vanished selection visible so a sync or scope change never hides an active filter.
  const listedAmounts = [...new Set([...amounts, ...value.amounts])].sort((a, b) => a - b);
  const update = (patch: Partial<PriceFilterValue>) => {
    const requiresUnit = !!patch.amounts?.length || (patch.sort !== undefined && patch.sort !== 'default');
    onChange({ ...value, ...(requiresUnit && value.unit === 'all' && units.length === 1 ? { unit: units[0] } : {}), ...patch });
  };
  const toggle = (amount: number) => update({ amounts: value.amounts.includes(amount) ? value.amounts.filter(item => item !== amount) : [...value.amounts, amount].sort((a, b) => a - b) });

  return <section className={`price-filter${filter.error ? ' price-filter-invalid' : ''}`} aria-label="商品额度筛选">
    <div className="price-filter-controls">
      <span className="price-filter-heading"><SlidersHorizontal size={14} />兑换额度 <span className="price-filter-multi">可多选</span></span>
      {listedUnits.length > 1 && <label className="price-filter-unit"><span>单位</span><div><select aria-label="额度单位" value={value.unit} disabled={disabled} onChange={event => update({ unit: event.target.value, amounts: [], ...(event.target.value === 'all' ? { sort: 'default' } : {}) })}><option value="all">全部单位</option>{listedUnits.map(unit => <option key={unit} value={unit}>{unit}{units.includes(unit) ? '' : '（当前范围暂无）'}</option>)}</select><ChevronDown size={13} /></div></label>}
      <div className="price-filter-amounts" role="group" aria-label="可选兑换额度">
        <button type="button" className={`amount-chip${!value.amounts.length ? ' selected' : ''}`} aria-pressed={!value.amounts.length} disabled={disabled} onClick={() => update({ amounts: [] })}>全部额度</button>
        {!needsUnit && listedAmounts.map(amount => {
          const selected = value.amounts.includes(amount), absent = !amounts.includes(amount);
          return <button type="button" key={amount} className={`amount-chip${selected ? ' selected' : ''}${absent ? ' absent' : ''}`} aria-label={`筛选 ${amount} ${effectiveUnit}`.trim()} aria-pressed={selected} disabled={disabled} onClick={() => toggle(amount)}>
            {selected && <Check size={12}/>}<span>{String(amount)}</span><small>{effectiveUnit}</small>{absent && <small>暂无商品</small>}
          </button>;
        })}
      </div>
      <label className="price-filter-sort"><span className="sr-only">额度排序</span><div><select aria-label="额度排序" value={value.sort} disabled={disabled || needsUnit} onChange={event => update({ sort: event.target.value as PriceFilterValue['sort'] })}><option value="default">默认排序</option><option value="ascending">额度从低到高</option><option value="descending">额度从高到低</option></select><ChevronDown size={13} /></div></label>
      {filter.active && <button type="button" className="price-filter-reset" disabled={disabled} onClick={() => onChange({ ...EMPTY_PRICE_FILTER })}><X size={13} />重置</button>}
    </div>
    {filter.error ? <p className="price-filter-error" role="alert">{filter.error}</p> : <p className="price-filter-note">{needsUnit ? '不同兑换单位分别筛选，请先选择单位。' : !listedAmounts.length ? '同步商品后会自动生成可选额度。' : '额度随当前卡片范围的商品报价同步更新，选中多个额度可合并查看。'}{filter.hasAmounts && ' 价格未确认的商品暂不显示。'}</p>}
  </section>;
}
