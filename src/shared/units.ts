export function unitKey(unit:string):string{
  const value=unit.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ');
  if(['元','人民币','cny','rmb','¥','￥'].includes(value))return'money:cny';
  if(['次','兑换次数','兑换次','redemptions','redemption'].includes(value))return'redemptions';
  if(value==='单次任选额度')return'selection-limit';
  return value;
}
